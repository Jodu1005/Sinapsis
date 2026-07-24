import path from 'node:path'
import { CommandRuntimeAvailabilityDetector, type RuntimeAvailability, type RuntimeAvailabilityDetector } from './runtime-profile'
import { LfJsonlParser } from './lf-jsonl-parser'
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
    this.request(session, session.isStreaming ? 'steer' : 'prompt', { text: input })
  }

  async resume(session: RuntimeSession, sink: RuntimeEventSink): Promise<void> {
    this.restoringSessions.add(session)
    this.launch(session, sink)
    if (session.sessionId || session.sessionFile) {
      this.request(session, 'switch_session', { sessionId: session.sessionId, sessionFile: session.sessionFile })
      return
    }
    this.request(session, 'get_state', {})
  }

  cancel(session: RuntimeSession): void {
    this.processes.get(session)?.kill()
  }

  private launch(session: RuntimeSession, sink: RuntimeEventSink): void {
    const args = [
      ...session.profile.args,
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
      if (code !== 0) sink({ kind: 'error', taskId: session.taskId, message: `Pi exited with ${code ?? signal ?? 'an unknown status'}.` })
    })
  }

  private request(session: RuntimeSession, command: string, args: Record<string, unknown>): void {
    const process = this.processes.get(session)
    if (!process) throw new Error('Runtime session has no active process.')
    process.write(`${JSON.stringify({ type: 'request', id: String(++this.requestId), command, args })}\n`)
  }

  private drain(session: RuntimeSession): void {
    if (this.restoringSessions.has(session) || session.isStreaming) return
    const input = session.pendingInputs.shift()
    if (input) {
      session.isStreaming = true
      this.request(session, 'prompt', { text: input })
    }
  }

  private recordJson(session: RuntimeSession, value: unknown, sink: RuntimeEventSink): void {
    if (!isRecord(value)) return
    const type = stringValue(value.type)
    if (type === 'message_update') {
      const delta = isRecord(value.delta) ? value.delta : value
      const text = stringValue(delta.text_delta)
      if (text) sink({ kind: 'text', taskId: session.taskId, text })
    }
    if (type === 'tool_execution_start') sink({ kind: 'tool_start', taskId: session.taskId, toolName: stringValue(value.tool_name) ?? 'unknown', toolCallId: stringValue(value.tool_call_id) })
    if (type === 'tool_execution_end') sink({ kind: 'tool_end', taskId: session.taskId, toolName: stringValue(value.tool_name) ?? 'unknown', toolCallId: stringValue(value.tool_call_id), success: value.success === true })
    if (type === 'queue_update') {
      const queueLength = numberValue(value.queue_length) ?? numberValue(value.queueLength)
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
  }

  private completeRestoration(session: RuntimeSession): void {
    if (!this.restoringSessions.has(session)) return
    this.restoringSessions.delete(session)
    session.isStreaming = false
    const initialPrompt = this.initialPrompts.get(session)
    if (initialPrompt) {
      this.initialPrompts.delete(session)
      session.isStreaming = true
      this.request(session, 'prompt', { text: initialPrompt })
      return
    }
    this.drain(session)
  }

  private saveSession(session: RuntimeSession, value: Record<string, unknown>, sink: RuntimeEventSink): void {
    const state = isRecord(value.state) ? value.state : isRecord(value.result) ? value.result : value
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
    sessionId: null,
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

function initialPrompt(task: RuntimeTaskRequest): string {
  return [
    'Work only in the assigned worktree. Do not push, merge, or modify files outside it.',
    `Task: ${task.title}`,
    task.description,
    `Acceptance criteria: ${task.acceptanceCriteria}`,
  ].join('\n\n')
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

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => index > 0 && /^(--(?:token|api[-_]?key|secret|password)|-[kK])$/i.test(args[index - 1])
    ? '[REDACTED]'
    : /^(--(?:token|api[-_]?key|secret|password)=).+/i.test(arg) ? `${arg.split('=')[0]}=[REDACTED]` : arg)
}
