import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { RuntimeKind } from '../adapters/runtime/runtime-profile'
import type { Agent } from '../domain/agent'
import type { ConversationSession } from '../domain/conversation'
import type { WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession, RuntimeTaskRequest } from '../ports/runtime'
import {
  parseDuplicateDecision,
  parseParticipation,
  parsePublicResponse,
  type DuplicateDecision,
  type ParticipationDecision,
  type PublicAgentResponse,
} from './agent-conversation-protocol'

type ConversationMetadata = NonNullable<RuntimeTaskRequest['conversation']>
export type ConversationProtocolResult = ParticipationDecision | PublicAgentResponse | DuplicateDecision

export interface ConversationSessionInvocation {
  channelId: string
  threadRootMessageId: string | null
  currentMessageId: string
  agent: Agent
  context: string
  initialMessage: string
  conversation?: ConversationMetadata
  candidateAgentIds?: string[]
  onSettled?(result: ConversationSessionResult): void
  onError?(error: Error): void
}

export interface ConversationSessionResult {
  text: string
  parsed: ConversationProtocolResult | null
}

export interface ConversationSessionServiceOptions {
  repositories: WorkspaceRepositories
  runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  conversationDirectory: string
}

interface ActiveInvocation {
  input: ConversationSessionInvocation
  lastMessageId: string
  pendingText: string[]
  completion: Promise<ConversationSessionResult>
  resolve(result: ConversationSessionResult): void
  reject(error: Error): void
}

interface DeferredRuntimeInput {
  message: string
}

type SessionPhase = 'preparing' | 'active' | 'cancelling' | 'ready' | 'failed'

interface SessionState {
  key: string
  taskId: string
  channelId: string
  threadRootMessageId: string | null
  agent: Agent
  adapter: RuntimeAdapter
  session: RuntimeSession | null
  runtimeSessionId: string | null
  runtimeSessionFile: string | null
  active: ActiveInvocation | null
  phase: SessionPhase
  cancellationRequested: boolean
  deferredInputs: DeferredRuntimeInput[]
  preparing: Promise<void>
}

export interface ConversationCancellationResult {
  cancelledSessionKeys: string[]
}

export interface ConversationInvocationCancellationResult extends ConversationCancellationResult {
  invocationId: string
}

export class ConversationInvocationCancelledError extends Error {
  constructor(readonly invocationId: string | null = null) {
    super('Conversation invocation was cancelled.')
    this.name = 'ConversationInvocationCancelledError'
  }
}

export class ConversationCancellationBatchError extends Error {
  constructor(
    readonly cancelledSessionKeys: string[],
    readonly failure: unknown,
  ) {
    super(asError(failure).message)
    this.name = 'ConversationCancellationBatchError'
  }
}

export class ConversationSessionService {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  private readonly conversationDirectory: string
  private readonly sessions = new Map<string, SessionState>()
  private readonly retiringSessions = new Set<SessionState>()

  constructor(options: ConversationSessionServiceOptions) {
    this.repositories = options.repositories
    this.runtimes = options.runtimes
    this.conversationDirectory = options.conversationDirectory
  }

  async invoke(input: ConversationSessionInvocation): Promise<ConversationSessionResult> {
    const key = conversationSessionKey(input.channelId, input.threadRootMessageId, input.agent.id)
    const adapter = this.runtimes[input.agent.runtime]
    if (!adapter) throw new Error(`Runtime ${input.agent.runtime} is unavailable.`)

    let state = this.sessions.get(key)
    if (state?.active) return this.redispatch(state, input)
    if (!state) {
      state = {
        key,
        taskId: `conversation-${randomUUID()}`,
        channelId: input.channelId,
        threadRootMessageId: input.threadRootMessageId,
        agent: input.agent,
        adapter,
        session: null,
        runtimeSessionId: null,
        runtimeSessionFile: null,
        active: null,
        phase: 'ready',
        cancellationRequested: false,
        deferredInputs: [],
        preparing: Promise.resolve(),
      }
      this.sessions.set(key, state)
    }

    let resolve!: (result: ConversationSessionResult) => void
    let reject!: (error: Error) => void
    const completion = new Promise<ConversationSessionResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    state.phase = 'preparing'
    state.cancellationRequested = false
    state.deferredInputs = []
    state.active = {
      input,
      lastMessageId: input.currentMessageId,
      pendingText: [],
      completion,
      resolve,
      reject,
    }
    state.preparing = this.prepareInvocation(state, input).catch((error: unknown) => {
      if (state!.cancellationRequested && !state!.active) {
        this.discardState(state!)
        return
      }
      this.fail(state!, asError(error))
    })
    return completion
  }

  async cancelChannel(channelId: string): Promise<ConversationCancellationResult> {
    return this.cancelSessions((state) => state.channelId === channelId)
  }

  async cancelAgentInChannel(channelId: string, agentId: string): Promise<ConversationCancellationResult> {
    return this.cancelSessions((state) => state.channelId === channelId && state.agent.id === agentId)
  }

  async cancelInvocation(invocationId: string): Promise<ConversationInvocationCancellationResult> {
    const result = this.cancelSessions((state) => state.active?.input.conversation?.invocationId === invocationId)
    return { invocationId, ...result }
  }

  private redispatch(state: SessionState, input: ConversationSessionInvocation): Promise<ConversationSessionResult> {
    const active = state.active!
    active.lastMessageId = input.currentMessageId
    if (state.phase === 'preparing') {
      state.deferredInputs.push({ message: input.initialMessage })
      return active.completion
    }

    try {
      this.persist(state, 'active', active.lastMessageId)
      state.adapter.sendInput(state.session!, input.initialMessage, (event) => this.handleRuntimeEvent(state, event))
    } catch (error) {
      this.fail(state, asError(error))
    }
    return active.completion
  }

  private async prepareInvocation(state: SessionState, input: ConversationSessionInvocation): Promise<void> {
    if (state.session) {
      state.phase = 'active'
      this.persist(state, 'active', state.active!.lastMessageId)
      state.adapter.sendInput(state.session, input.initialMessage, (event) => this.handleRuntimeEvent(state, event))
      this.flushDeferredInputs(state)
      return
    }

    const persisted = this.repositories.getConversationSession(state.key)
    if (isRecoverable(persisted, input.agent.runtime)) {
      const conversationPath = path.join(this.conversationDirectory, input.channelId, input.agent.id)
      mkdirSync(conversationPath, { recursive: true })
      state.runtimeSessionId = persisted.runtimeSessionId
      state.runtimeSessionFile = persisted.runtimeSessionFile
      state.session = createResumedRuntimeSession(
        state,
        input.agent,
        conversationPath,
      )
      this.persist(state, 'active', input.currentMessageId)
      try {
        await state.adapter.resume(state.session, (event) => this.handleRuntimeEvent(state, event))
      } catch {
        if (state.cancellationRequested || !state.active) return
        this.persist(state, 'stale', persisted.lastMessageId)
        state.session = null
        state.runtimeSessionId = null
        state.runtimeSessionFile = null
        await this.startColdSession(state, input)
        return
      }
      if (state.cancellationRequested || !state.active) return
      state.phase = 'active'
      state.adapter.sendInput(state.session, input.initialMessage, (event) => this.handleRuntimeEvent(state, event))
      this.flushDeferredInputs(state)
      return
    }

    await this.startColdSession(state, input)
  }

  private async startColdSession(state: SessionState, input: ConversationSessionInvocation): Promise<void> {
    const channel = this.repositories.getChannel(input.channelId)
    if (!channel) throw new Error(`Channel ${input.channelId} does not exist.`)
    const conversationPath = path.join(this.conversationDirectory, input.channelId, input.agent.id)
    mkdirSync(conversationPath, { recursive: true })
    const session = await state.adapter.start({
      taskId: state.taskId,
      mode: 'conversation',
      title: `频道 #${channel.name} 对话`,
      description: `${input.context}\n\n当前 Agent 职责：${input.agent.responsibilities?.join('；') || '未设置（仅处理被直接提及的消息）'}。`,
      acceptanceCriteria: '在频道中给出简洁、清晰的回复。',
      initialMessage: input.initialMessage,
      worktreePath: conversationPath,
      profile: {
        runtime: input.agent.runtime,
        command: input.agent.command,
        args: input.agent.args,
        model: input.agent.model,
        env: input.agent.env,
        policy: 'task-worktree',
      },
      conversation: input.conversation,
    }, (event) => this.handleRuntimeEvent(state, event))

    if (!this.isTrackedGeneration(state)) {
      this.cancelUnownedSession(state.adapter, session)
      return
    }
    state.session = session
    state.runtimeSessionId = state.runtimeSessionId ?? session.sessionId
    state.runtimeSessionFile = state.runtimeSessionFile ?? session.sessionFile
    session.sessionId = state.runtimeSessionId
    session.sessionFile = state.runtimeSessionFile
    if (state.cancellationRequested) {
      this.cancelPreparedSession(state)
      return
    }
    if (!state.active) return
    state.phase = 'active'
    this.persist(state, 'active', state.active.lastMessageId)
    this.flushDeferredInputs(state)
  }

  private handleRuntimeEvent(state: SessionState, event: RuntimeEvent): void {
    if (event.taskId !== state.taskId || !state.active || state.phase === 'cancelling') return
    try {
      switch (event.kind) {
        case 'session':
          state.runtimeSessionId = event.sessionId
          state.runtimeSessionFile = event.sessionFile ?? state.runtimeSessionFile
          if (state.session) {
            state.session.sessionId = event.sessionId
            state.session.sessionFile = state.runtimeSessionFile
          }
          this.persist(state, 'active', state.active.lastMessageId)
          return
        case 'text':
          state.active.pendingText.push(event.text)
          return
        case 'settled':
          this.settle(state)
          return
        case 'error':
          this.fail(state, new Error(event.message))
          return
        case 'artifact':
        case 'tool_start':
        case 'tool_end':
        case 'queue':
        case 'needs_input':
          return
      }
    } catch (error) {
      this.fail(state, asError(error))
    }
  }

  private settle(state: SessionState): void {
    const active = state.active
    if (!active || state.phase === 'cancelling') return
    const rawText = active.pendingText.join('').trim()
    state.active = null
    state.phase = 'ready'
    try {
      this.persist(state, 'ready', active.lastMessageId)
      const result = parseResult(rawText, active.input)
      active.input.onSettled?.(result)
      active.resolve(result)
    } catch (error) {
      this.rejectInvocation(active, asError(error))
    }
  }

  private fail(state: SessionState, error: Error): void {
    const active = state.active
    if (!active) return
    state.active = null
    state.phase = 'failed'
    this.discardState(state)
    try {
      this.persist(state, 'failed', active.lastMessageId)
    } catch {
      // The Runtime/setup error remains the primary invocation failure.
    }
    this.rejectInvocation(active, error)
  }

  private cancelSessions(predicate: (state: SessionState) => boolean): ConversationCancellationResult {
    const candidates = new Set([...this.sessions.values(), ...this.retiringSessions])
    const matches = [...candidates].filter((state) => (state.active || state.cancellationRequested) && predicate(state))
    const cancelledSessionKeys: string[] = []
    const failures: unknown[] = []
    for (const state of matches) {
      const outcome = this.requestCancellation(state)
      if (outcome.cancelled) cancelledSessionKeys.push(state.key)
      if (outcome.failure) failures.push(outcome.failure)
    }
    if (failures.length > 0) throw new ConversationCancellationBatchError(cancelledSessionKeys, failures[0])
    return { cancelledSessionKeys }
  }

  private requestCancellation(state: SessionState): { cancelled: boolean; failure?: unknown } {
    const active = state.active
    const previousPhase = state.phase
    state.cancellationRequested = true
    state.phase = 'cancelling'

    if (!state.session) {
      const failure = active ? this.finishCancelledInvocation(state, active) : undefined
      this.retireState(state)
      return { cancelled: true, failure }
    }

    try {
      state.adapter.cancel(state.session)
    } catch (error) {
      state.cancellationRequested = false
      state.phase = previousPhase
      return { cancelled: false, failure: error }
    }

    const failure = active ? this.finishCancelledInvocation(state, active) : undefined
    this.discardState(state)
    return { cancelled: true, failure }
  }

  private finishCancelledInvocation(state: SessionState, active: ActiveInvocation): unknown {
    state.active = null
    state.deferredInputs = []
    let persistenceFailure: unknown
    try {
      this.persist(state, 'stale', active.lastMessageId)
    } catch (error) {
      persistenceFailure = error
    }
    active.reject(new ConversationInvocationCancelledError(active.input.conversation?.invocationId ?? null))
    return persistenceFailure
  }

  private cancelPreparedSession(state: SessionState): void {
    if (!state.session || !state.cancellationRequested) return
    state.phase = 'cancelling'
    try {
      state.adapter.cancel(state.session)
      this.discardState(state)
    } catch {
      // Keep the intent and session so a later explicit cancellation can retry.
    }
  }

  private retireState(state: SessionState): void {
    if (this.sessions.get(state.key) === state) this.sessions.delete(state.key)
    this.retiringSessions.add(state)
  }

  private discardState(state: SessionState): void {
    if (this.sessions.get(state.key) === state) this.sessions.delete(state.key)
    this.retiringSessions.delete(state)
  }

  private isTrackedGeneration(state: SessionState): boolean {
    return this.sessions.get(state.key) === state || this.retiringSessions.has(state)
  }

  private cancelUnownedSession(adapter: RuntimeAdapter, session: RuntimeSession): void {
    try {
      adapter.cancel(session)
    } catch {
      // The generation is already detached; its Runtime session must not regain ownership.
    }
  }

  private flushDeferredInputs(state: SessionState): void {
    if (!state.session || !state.active || state.phase !== 'active') return
    const pending = state.deferredInputs
    state.deferredInputs = []
    for (const input of pending) {
      state.adapter.sendInput(state.session, input.message, (event) => this.handleRuntimeEvent(state, event))
    }
  }

  private rejectInvocation(active: ActiveInvocation, error: Error): void {
    try {
      active.input.onError?.(error)
    } catch {
      // Observer failures cannot replace the invocation's primary failure.
    }
    active.reject(error)
  }

  private persist(state: SessionState, status: ConversationSession['status'], lastMessageId: string | null): void {
    this.repositories.upsertConversationSession({
      key: state.key,
      channelId: state.channelId,
      threadRootMessageId: state.threadRootMessageId,
      agentId: state.agent.id,
      runtime: state.agent.runtime,
      runtimeSessionId: state.runtimeSessionId,
      runtimeSessionFile: state.runtimeSessionFile,
      status,
      lastMessageId,
    })
  }
}

export function conversationSessionKey(channelId: string, threadRootMessageId: string | null, agentId: string): string {
  return `${channelId}:${threadRootMessageId ?? 'timeline'}:${agentId}`
}

function isRecoverable(session: ConversationSession | undefined, runtime: RuntimeKind): session is ConversationSession {
  return session !== undefined
    && session.runtime === runtime
    && session.status !== 'stale'
    && session.status !== 'failed'
    && (session.runtimeSessionId !== null || session.runtimeSessionFile !== null)
}

function createResumedRuntimeSession(state: SessionState, agent: Agent, worktreePath: string): RuntimeSession {
  return {
    taskId: state.taskId,
    runtime: agent.runtime,
    worktreePath,
    profile: {
      runtime: agent.runtime,
      command: agent.command,
      args: agent.args,
      model: agent.model,
      env: agent.env,
      policy: 'task-worktree',
    },
    sessionId: state.runtimeSessionId,
    sessionFile: state.runtimeSessionFile,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

function parseResult(rawText: string, input: ConversationSessionInvocation): ConversationSessionResult {
  if (!input.conversation) return { text: rawText, parsed: null }
  switch (input.conversation.expectedOutput) {
    case 'participation': {
      const parsed = parseParticipation(rawText, input.candidateAgentIds ?? [])
      return { text: rawText, parsed }
    }
    case 'public_response': {
      const parsed = parsePublicResponse(rawText)
      return { text: parsed.reply, parsed }
    }
    case 'duplicate': {
      const parsed = parseDuplicateDecision(rawText)
      return { text: rawText, parsed }
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Conversation Runtime failed.')
}
