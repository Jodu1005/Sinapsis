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
  pendingText: string[]
  resolve(result: ConversationSessionResult): void
  reject(error: Error): void
}

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
  preparing: Promise<void>
}

export class ConversationSessionService {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  private readonly conversationDirectory: string
  private readonly sessions = new Map<string, SessionState>()

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
    if (state?.active) throw new Error(`Conversation session ${key} already has an active invocation.`)
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
    state.active = { input, pendingText: [], resolve, reject }
    state.preparing = this.prepareInvocation(state, input).catch((error: unknown) => {
      this.fail(state!, asError(error))
    })
    await state.preparing
    return completion
  }

  async cancelChannel(channelId: string): Promise<void> {
    await this.cancelSessions((state) => state.channelId === channelId)
  }

  async cancelAgentInChannel(channelId: string, agentId: string): Promise<void> {
    await this.cancelSessions((state) => state.channelId === channelId && state.agent.id === agentId)
  }

  private async prepareInvocation(state: SessionState, input: ConversationSessionInvocation): Promise<void> {
    if (state.session) {
      this.persist(state, 'active', input.currentMessageId)
      state.adapter.sendInput(state.session, input.initialMessage, (event) => this.handleRuntimeEvent(state, event))
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
        this.persist(state, 'stale', persisted.lastMessageId)
        state.session = null
        state.runtimeSessionId = null
        state.runtimeSessionFile = null
        await this.startColdSession(state, input)
        return
      }
      state.adapter.sendInput(state.session, input.initialMessage, (event) => this.handleRuntimeEvent(state, event))
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

    state.session = session
    state.runtimeSessionId = state.runtimeSessionId ?? session.sessionId
    state.runtimeSessionFile = state.runtimeSessionFile ?? session.sessionFile
    session.sessionId = state.runtimeSessionId
    session.sessionFile = state.runtimeSessionFile
    if (state.active) this.persist(state, 'active', input.currentMessageId)
  }

  private handleRuntimeEvent(state: SessionState, event: RuntimeEvent): void {
    if (event.taskId !== state.taskId || !state.active) return
    switch (event.kind) {
      case 'session':
        state.runtimeSessionId = event.sessionId
        state.runtimeSessionFile = event.sessionFile ?? state.runtimeSessionFile
        if (state.session) {
          state.session.sessionId = event.sessionId
          state.session.sessionFile = state.runtimeSessionFile
        }
        this.persist(state, 'active', state.active.input.currentMessageId)
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
  }

  private settle(state: SessionState): void {
    const active = state.active
    if (!active) return
    const rawText = active.pendingText.join('').trim()
    state.active = null
    this.persist(state, 'ready', active.input.currentMessageId)
    try {
      const result = parseResult(rawText, active.input)
      active.input.onSettled?.(result)
      active.resolve(result)
    } catch (error) {
      const parsedError = asError(error)
      active.input.onError?.(parsedError)
      active.reject(parsedError)
    }
  }

  private fail(state: SessionState, error: Error): void {
    const active = state.active
    if (!active) return
    state.active = null
    this.persist(state, 'failed', active.input.currentMessageId)
    this.sessions.delete(state.key)
    active.input.onError?.(error)
    active.reject(error)
  }

  private async cancelSessions(predicate: (state: SessionState) => boolean): Promise<void> {
    const matches = [...this.sessions.values()].filter((state) => state.active && predicate(state))
    const failures: unknown[] = []
    for (const state of matches) {
      await state.preparing
      if (!state.active) continue
      try {
        if (state.session) state.adapter.cancel(state.session)
      } catch (error) {
        failures.push(error)
        continue
      }
      const active = state.active
      state.active = null
      this.persist(state, 'stale', active.input.currentMessageId)
      this.sessions.delete(state.key)
      active.reject(new Error('Conversation invocation was cancelled.'))
    }
    if (failures.length > 0) throw failures[0]
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
