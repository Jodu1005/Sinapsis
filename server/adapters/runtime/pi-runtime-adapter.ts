import path from 'node:path'
import { CommandRuntimeAvailabilityDetector, type RuntimeAvailability, type RuntimeAvailabilityDetector } from './runtime-profile'
import { LfJsonlParser } from './lf-jsonl-parser'
import { classifyRuntimeError } from './runtime-errors'
import type { ProcessHandle, ProcessRunner } from '../../ports/process-runner'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../../ports/runtime'

export class PiRuntimeAdapter implements RuntimeAdapter {
  private readonly processes = new WeakMap<RuntimeSession, ProcessHandle>()
  private readonly initialPrompts = new WeakMap<RuntimeSession, string>()
  private readonly restoringSessions = new WeakSet<RuntimeSession>()
  private requestId = 0

  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly dataDirectory = process.cwd(),
    private readonly availabilityDetector: RuntimeAvailabilityDetector = new CommandRuntimeAvailabilityDetector(),
  ) {}

  detect(profile: RuntimeTaskRequest['profile']): Promise<RuntimeAvailability> {
    return this.availabilityDetector.detect(profile)
  }

  async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    const session = createSession(task)
    this.initialPrompts.set(session, initialPrompt(task))
    this.restoringSessions.add(session)
    this.launch(session, sink)
    this.request(session, 'get_state', {})
    return session
  }

  sendInput(session: RuntimeSession, input: string, _sink: RuntimeEventSink): void {
    if (!input.trim()) return
    if (this.restoringSessions.has(session)) {
      session.pendingInputs.push(input)
      return
    }
    this.request(session, session.isStreaming ? 'steer' : 'prompt', { message: input })
  }

  async resume(session: RuntimeSession, sink: RuntimeEventSink): Promise<void> {
    this.restoringSessions.add(session)
    this.launch(session, sink)
    if (session.sessionFile) {
      this.request(session, 'switch_session', { sessionPath: session.sessionFile })
      return
    }
    this.request(session, 'get_state', {})
  }

  cancel(session: RuntimeSession): void {
    this.processes.get(session)?.kill()
  }

  private launch(session: RuntimeSession, sink: RuntimeEventSink): void {
    const args = session.executionPolicy === 'read-only-no-tools'
      ? [...restrictedPiArgs(), ...modelArgs(session.profile.model)]
      : [
          ...session.profile.args,
          ...modelArgs(session.profile.model),
          '--session-dir', path.join(this.dataDirectory, 'pi-sessions'),
          '--name', `sinapsis:${session.taskId}`,
        ]
    const process = this.processRunner.spawn({
      command: session.profile.command,
      args,
      cwd: session.worktreePath,
      env: session.profile.env,
    })
    const parser = new LfJsonlParser()
    let stderr = ''
    session.isStreaming = true
    this.processes.set(session, process)
    process.onStdout((chunk) => {
      sink({ kind: 'artifact', taskId: session.taskId, artifactType: 'runtime-jsonl', content: chunk })
      for (const line of parser.push(chunk)) this.recordJson(session, line.value, sink)
    })
    process.onStderr((chunk) => {
      stderr += chunk
      sink({ kind: 'artifact', taskId: session.taskId, artifactType: 'runtime-stderr', content: chunk })
    })
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
        const message = stderr.trim() || `Pi exited with ${code ?? signal ?? 'an unknown status'}.`
        const errorCode = classifyRuntimeError(message)
        sink({
          kind: 'error',
          taskId: session.taskId,
          message: errorCode === 'session_lost' ? 'Pi session not found.' : `Pi exited with ${code ?? signal ?? 'an unknown status'}.`,
          ...(errorCode === 'session_lost' ? { errorCode } : {}),
        })
      }
    })
  }

  private request(session: RuntimeSession, type: string, args: Record<string, unknown>): void {
    const process = this.processes.get(session)
    if (!process) throw new Error('Runtime session has no active process.')
    process.write(`${JSON.stringify({ id: String(++this.requestId), type, ...args })}\n`)
  }

  private drain(session: RuntimeSession): void {
    if (this.restoringSessions.has(session) || session.isStreaming) return
    const input = session.pendingInputs.shift()
    if (input) {
      session.isStreaming = true
      this.request(session, 'prompt', { message: input })
    }
  }

  private recordJson(session: RuntimeSession, value: unknown, sink: RuntimeEventSink): void {
    if (!isRecord(value)) return
    const type = stringValue(value.type)
    if (type === 'message_update') {
      const event = isRecord(value.assistantMessageEvent) ? value.assistantMessageEvent : isRecord(value.delta) ? value.delta : value
      const eventType = stringValue(event.type)
      if (eventType !== undefined && eventType !== 'text_delta') return
      const text = stringValue(event.delta) ?? stringValue(event.text_delta)
      if (text) sink({ kind: 'text', taskId: session.taskId, text })
    }
    if (type === 'tool_execution_start') sink({ kind: 'tool_start', taskId: session.taskId, toolName: stringValue(value.toolName) ?? stringValue(value.tool_name) ?? 'unknown', toolCallId: stringValue(value.toolCallId) ?? stringValue(value.tool_call_id) })
    if (type === 'tool_execution_end') sink({ kind: 'tool_end', taskId: session.taskId, toolName: stringValue(value.toolName) ?? stringValue(value.tool_name) ?? 'unknown', toolCallId: stringValue(value.toolCallId) ?? stringValue(value.tool_call_id), success: value.isError !== true && value.success !== false })
    if (type === 'queue_update') {
      const queueLength = numberValue(value.queue_length) ?? numberValue(value.queueLength) ?? queueLengthFrom(value)
      if (queueLength !== undefined) {
        session.queueLength = queueLength
        sink({ kind: 'queue', taskId: session.taskId, queueLength })
      }
    }
    if (type === 'agent_settled') {
      session.isStreaming = false
      if (session.pendingInputs.length > 0) {
        this.drain(session)
        return
      }
      sink({ kind: 'settled', taskId: session.taskId })
    }
    if (type === 'get_state' || type === 'state') {
      this.saveSession(session, value, sink)
      this.completeRestoration(session)
    }
    if (type === 'response' && value.command === 'get_state' && value.success === true) {
      this.saveSession(session, value, sink)
      this.completeRestoration(session)
    }
    if (type === 'response' && value.command === 'switch_session' && value.success === true) this.completeRestoration(session)
    if (type === 'response' && value.success === false) {
      const message = stringValue(value.error) ?? `Pi rejected ${stringValue(value.command) ?? 'an RPC command'}.`
      const errorCode = value.command === 'switch_session' ? 'session_lost' : classifyRuntimeError(message)
      sink({ kind: 'error', taskId: session.taskId, message, ...(errorCode === 'session_lost' ? { errorCode } : {}) })
    }
  }

  private completeRestoration(session: RuntimeSession): void {
    if (!this.restoringSessions.has(session)) return
    this.restoringSessions.delete(session)
    session.isStreaming = false
    const initialPrompt = this.initialPrompts.get(session)
    if (initialPrompt) {
      this.initialPrompts.delete(session)
      session.isStreaming = true
      this.request(session, 'prompt', { message: initialPrompt })
      return
    }
    this.drain(session)
  }

  private saveSession(session: RuntimeSession, value: Record<string, unknown>, sink: RuntimeEventSink): void {
    const state = isRecord(value.data) ? value.data : isRecord(value.state) ? value.state : isRecord(value.result) ? value.result : value
    const sessionId = stringValue(state.sessionId)
    const sessionFile = stringValue(state.sessionFile)
    if (!sessionId) return
    session.sessionId = sessionId
    session.sessionFile = sessionFile ?? session.sessionFile
    sink({ kind: 'session', taskId: session.taskId, sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}) })
  }
}

function createSession(task: RuntimeTaskRequest): RuntimeSession {
  return {
    taskId: task.taskId,
    runtime: 'pi',
    worktreePath: task.worktreePath,
    profile: task.profile,
    executionPolicy: task.executionPolicy ?? 'default',
    sessionId: null,
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

function restrictedPiArgs(): string[] {
  return [
    '--mode', 'rpc',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-session',
    '--no-approve',
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
    'Work only in the assigned worktree. Do not push, merge, or modify files outside it. Completion is determined by the task result, not Git activity. Do not create a branch or commit unless the task explicitly asks for one.',
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function queueLengthFrom(value: Record<string, unknown>): number | undefined {
  const steering = Array.isArray(value.steering) ? value.steering.length : undefined
  const followUp = Array.isArray(value.followUp) ? value.followUp.length : undefined
  return steering === undefined && followUp === undefined ? undefined : (steering ?? 0) + (followUp ?? 0)
}

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => index > 0 && /^(--(?:token|api[-_]?key|secret|password)|-[kK])$/i.test(args[index - 1])
    ? '[REDACTED]'
    : /^(--(?:token|api[-_]?key|secret|password)=).+/i.test(arg) ? `${arg.split('=')[0]}=[REDACTED]` : arg)
}
