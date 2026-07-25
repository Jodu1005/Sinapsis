import { CommandRuntimeAvailabilityDetector, type RuntimeAvailability, type RuntimeAvailabilityDetector } from './runtime-profile'
import { LfJsonlParser } from './lf-jsonl-parser'
import type { ProcessHandle, ProcessRunner } from '../../ports/process-runner'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../../ports/runtime'

export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
  private readonly processes = new WeakMap<RuntimeSession, ProcessHandle>()

  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly availabilityDetector: RuntimeAvailabilityDetector = new CommandRuntimeAvailabilityDetector(),
  ) {}

  detect(profile: RuntimeTaskRequest['profile']): Promise<RuntimeAvailability> {
    return this.availabilityDetector.detect(profile)
  }

  async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    const session = createSession(task)
    this.launch(session, initialPrompt(task), sink)
    return session
  }

  sendInput(session: RuntimeSession, input: string, sink: RuntimeEventSink): void {
    if (!input.trim()) return
    session.pendingInputs.push(input)
    this.drain(session, sink)
  }

  async resume(session: RuntimeSession, sink: RuntimeEventSink): Promise<void> {
    this.drain(session, sink)
  }

  cancel(session: RuntimeSession): void {
    this.processes.get(session)?.kill()
  }

  private drain(session: RuntimeSession, sink: RuntimeEventSink): void {
    if (session.isStreaming) return
    const input = session.pendingInputs.shift()
    if (input) this.launch(session, input, sink)
  }

  private launch(session: RuntimeSession, prompt: string, sink: RuntimeEventSink): void {
    const args = [...session.profile.args, '--format', 'json', '--dir', session.worktreePath]
    if (session.profile.model) args.push('--model', session.profile.model)
    if (session.sessionId) args.push('--session', session.sessionId)
    args.push(prompt)

    const process = this.processRunner.spawn({
      command: session.profile.command,
      args,
      cwd: session.worktreePath,
      env: session.profile.env,
    })
    const parser = new LfJsonlParser()
    session.isStreaming = true
    this.processes.set(session, process)

    process.onStdout((chunk) => {
      sink({ kind: 'artifact', taskId: session.taskId, artifactType: 'runtime-jsonl', content: chunk })
      for (const line of parser.push(chunk)) this.recordJson(session, line.value, sink)
    })
    process.onStderr((chunk) => sink({ kind: 'artifact', taskId: session.taskId, artifactType: 'runtime-stderr', content: chunk }))
    process.onError((error) => sink({ kind: 'error', taskId: session.taskId, message: error.message }))
    process.onExit(({ code, signal }) => {
      session.isStreaming = false
      sink({
        kind: 'artifact',
        taskId: session.taskId,
        artifactType: 'runtime-exit',
        content: JSON.stringify({ command: session.profile.command, args: redactArgs(args), cwd: session.worktreePath, code, signal }),
      })
      if (code !== 0) {
        sink({ kind: 'error', taskId: session.taskId, message: `OpenCode exited with ${code ?? signal ?? 'an unknown status'}.` })
        return
      }
      if (session.pendingInputs.length > 0) {
        this.drain(session, sink)
        return
      }
      sink({ kind: 'settled', taskId: session.taskId })
    })
  }

  private recordJson(session: RuntimeSession, value: unknown, sink: RuntimeEventSink): void {
    if (!isRecord(value)) return
    const sessionId = stringValue(value.sessionID) ?? stringValue(value.sessionId)
    if (sessionId) {
      session.sessionId = sessionId
      sink({ kind: 'session', taskId: session.taskId, sessionId })
    }
    const type = stringValue(value.type)
    const text = stringValue(value.text) ?? stringValue(value.content)
    if (text && (type === 'text' || type === 'message')) sink({ kind: 'text', taskId: session.taskId, text })
    if (type === 'tool_start') sink({ kind: 'tool_start', taskId: session.taskId, toolName: stringValue(value.tool) ?? 'unknown', toolCallId: stringValue(value.id) })
    if (type === 'tool_end') sink({ kind: 'tool_end', taskId: session.taskId, toolName: stringValue(value.tool) ?? 'unknown', toolCallId: stringValue(value.id), success: value.success === true })
    if (type === 'error') sink({ kind: 'error', taskId: session.taskId, message: stringValue(value.message) ?? 'OpenCode reported an error.' })
  }
}

function createSession(task: RuntimeTaskRequest): RuntimeSession {
  return {
    taskId: task.taskId,
    runtime: 'opencode',
    worktreePath: task.worktreePath,
    profile: task.profile,
    sessionId: null,
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

function initialPrompt(task: RuntimeTaskRequest): string {
  if (task.mode === 'conversation') return conversationPrompt(task)
  return taskPrompt(task)
}

function taskPrompt(task: RuntimeTaskRequest): string {
  return [
    'You are working on a single assigned task inside the provided worktree.',
    'Do not push, merge, or modify files outside this worktree. You may run tests and create a commit on the task branch.',
    `Task: ${task.title}`,
    task.description,
    `Acceptance criteria: ${task.acceptanceCriteria}`,
  ].join('\n\n')
}

function conversationPrompt(task: RuntimeTaskRequest): string {
  return [
    'You are participating in a read-only channel conversation.',
    'Do not edit or create files. Do not commit. Do not push. Do not merge. Do not run commands that modify the working directory or repository state.',
    `Recent channel context:\n${task.description}`,
    task.initialMessage ? `Initial human message:\n${task.initialMessage}` : undefined,
    'Reply clearly and concisely to the human message.',
  ].filter((section): section is string => Boolean(section)).join('\n\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => index > 0 && /^(--(?:token|api[-_]?key|secret|password)|-[kK])$/i.test(args[index - 1])
    ? '[REDACTED]'
    : /^(--(?:token|api[-_]?key|secret|password)=).+/i.test(arg) ? `${arg.split('=')[0]}=[REDACTED]` : arg)
}
