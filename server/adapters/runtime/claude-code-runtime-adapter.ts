import { randomUUID } from 'node:crypto'
import { CommandRuntimeAvailabilityDetector, type RuntimeAvailability, type RuntimeAvailabilityDetector } from './runtime-profile'
import { LfJsonlParser } from './lf-jsonl-parser'
import type { ProcessHandle, ProcessRunner } from '../../ports/process-runner'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../../ports/runtime'

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  private readonly processes = new WeakMap<RuntimeSession, ProcessHandle>()
  private readonly toolNames = new WeakMap<RuntimeSession, Map<string, string>>()
  private readonly conversationSessions = new WeakSet<RuntimeSession>()

  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly availabilityDetector: RuntimeAvailabilityDetector = new CommandRuntimeAvailabilityDetector(),
  ) {}

  detect(profile: RuntimeTaskRequest['profile']): Promise<RuntimeAvailability> {
    return this.availabilityDetector.detect(profile)
  }

  async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    const session = createSession(task)
    this.toolNames.set(session, new Map())
    if (task.mode === 'conversation') this.conversationSessions.add(session)
    this.launch(session, initialPrompt(task), sink, false)
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
    if (input) this.launch(session, input, sink, true)
  }

  private launch(session: RuntimeSession, prompt: string, sink: RuntimeEventSink, resume: boolean): void {
    const args = resume ? resumeArgs(session, prompt) : startArgs(session, prompt)
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
        sink({ kind: 'error', taskId: session.taskId, message: `Claude Code exited with ${code ?? signal ?? 'an unknown status'}.` })
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

    const type = stringValue(value.type)
    const subtype = stringValue(value.subtype)
    const isConversation = this.conversationSessions.has(session)
    if ((type === 'system' || type === 'init') && subtype === 'init' || type === 'init') {
      const sessionId = stringValue(value.session_id) ?? stringValue(value.sessionId)
      if (sessionId) {
        session.sessionId = sessionId
        sink({ kind: 'session', taskId: session.taskId, sessionId })
      }
    }

    if (type === 'assistant') {
      for (const block of contentBlocks(value)) this.recordContentBlock(session, block, sink, !isConversation)
      const text = stringValue(value.text)
      if (text && !isConversation) sink({ kind: 'text', taskId: session.taskId, text })
    }

    if (type === 'user' || type === 'tool_result') {
      for (const block of contentBlocks(value)) this.recordContentBlock(session, block, sink, !isConversation)
    }

    if (type === 'error' || subtype === 'error' || value.success === false || value.is_error === true) {
      const message = errorMessage(value)
      if (message) sink({ kind: 'error', taskId: session.taskId, message })
    }

    if (type === 'result' && subtype !== 'error') {
      const text = stringValue(value.result) ?? stringValue(value.message)
      if (text) sink({ kind: 'text', taskId: session.taskId, text })
    }
  }

  private recordContentBlock(session: RuntimeSession, block: Record<string, unknown>, sink: RuntimeEventSink, emitText: boolean): void {
    const type = stringValue(block.type)
    if (type === 'text') {
      const text = stringValue(block.text)
      if (text && emitText) sink({ kind: 'text', taskId: session.taskId, text })
      return
    }
    if (type === 'tool_use') {
      const toolName = stringValue(block.name) ?? stringValue(block.tool_name) ?? 'unknown'
      const toolCallId = stringValue(block.id)
      if (toolCallId) this.toolNames.get(session)?.set(toolCallId, toolName)
      sink({ kind: 'tool_start', taskId: session.taskId, toolName, toolCallId })
      return
    }
    if (type === 'tool_result') {
      const toolCallId = stringValue(block.tool_use_id) ?? stringValue(block.id)
      const toolName = stringValue(block.name) ?? (toolCallId ? this.toolNames.get(session)?.get(toolCallId) : undefined) ?? 'unknown'
      sink({ kind: 'tool_end', taskId: session.taskId, toolName, toolCallId, success: block.is_error !== true })
    }
  }
}

function createSession(task: RuntimeTaskRequest): RuntimeSession {
  return {
    taskId: task.taskId,
    runtime: 'claude-code',
    worktreePath: task.worktreePath,
    profile: task.profile,
    sessionId: randomUUID(),
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

function startArgs(session: RuntimeSession, prompt: string): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--session-id',
    session.sessionId ?? randomUUID(),
    ...modelArgs(session.profile.model),
    ...session.profile.args,
    prompt,
  ]
}

function resumeArgs(session: RuntimeSession, prompt: string): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--resume',
    session.sessionId ?? randomUUID(),
    ...modelArgs(session.profile.model),
    ...session.profile.args,
    prompt,
  ]
}

function modelArgs(model: string): string[] {
  return model ? ['--model', model] : []
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
    'Reply directly and concisely to the human message. Return only the final answer: do not narrate analysis, plans, tool use, browsing, or progress updates.',
  ].filter((section): section is string => Boolean(section)).join('\n\n')
}

function contentBlocks(value: Record<string, unknown>): Record<string, unknown>[] {
  const message = isRecord(value.message) ? value.message : undefined
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(value.content) ? value.content : []
  return content.filter(isRecord)
}

function errorMessage(value: Record<string, unknown>): string | undefined {
  if (typeof value.error === 'string') return value.error
  if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message
  return stringValue(value.message) ?? stringValue(value.result)
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
