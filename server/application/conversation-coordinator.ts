import type { RuntimeKind } from '../adapters/runtime/runtime-profile'
import type { Agent } from '../domain/agent'
import type { Message } from '../domain/message'
import { DomainError } from '../domain/task'
import type { Channel } from '../domain/workspace'
import type { WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter } from '../ports/runtime'
import { ChannelMessageService } from './channel-message-service'
import { ContextAssembler } from './context-assembler'
import {
  ConversationCancellationBatchError,
  ConversationInvocationCancelledError,
  ConversationSessionService,
  conversationSessionKey,
  type ConversationCancellationResult,
  type ConversationSessionResult,
} from './conversation-session-service'

export interface ConversationCoordinatorOptions {
  repositories: WorkspaceRepositories
  runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  conversationDirectory: string
  messages?: ChannelMessageService
  sessions?: ConversationSessionService
  contextAssembler?: ContextAssembler
}

interface ConversationExecution {
  key: string
  channelId: string
  threadRootMessageId: string | null
  agent: Agent
  active: boolean
}

const conversationContextBudget = 4_000

export class ConversationCoordinator {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  private readonly messages: ChannelMessageService
  private readonly sessions: ConversationSessionService
  private readonly contextAssembler: ContextAssembler
  private readonly executions = new Map<string, ConversationExecution>()

  constructor(options: ConversationCoordinatorOptions) {
    this.repositories = options.repositories
    this.runtimes = options.runtimes
    this.messages = options.messages ?? new ChannelMessageService(options.repositories)
    this.sessions = options.sessions ?? new ConversationSessionService({
      repositories: options.repositories,
      runtimes: options.runtimes,
      conversationDirectory: options.conversationDirectory,
    })
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(options.repositories)
  }

  async dispatch(channelId: string, message: Message): Promise<void> {
    if (message.channelId !== channelId) throw new DomainError('Message does not belong to this channel.')

    this.requireChannel(channelId)
    const threadRootMessageId = message.threadRootMessageId ?? null
    const memberAgentIds = new Set(this.repositories.getChannelAgentIds(channelId))
    const agents = this.repositories.listAgents().filter((agent) => memberAgentIds.has(agent.id))
    const agent = this.selectAgent(agents, channelId, threadRootMessageId, message.body)
    if (!agent) return

    const key = conversationSessionKey(channelId, threadRootMessageId, agent.id)

    const adapter = this.runtimes[agent.runtime]
    if (!adapter) {
      this.messages.postAgent(channelId, null, agent.identity, '抱歉，我暂时无法回复：此 Agent 的 Runtime 不可用。')
      return
    }

    const existing = this.executions.get(key)
    if (existing?.active) {
      const invocation = this.sessions.invoke({
        channelId,
        threadRootMessageId,
        currentMessageId: message.id,
        agent,
        context: '',
        initialMessage: message.body,
      })
      this.observeInvocation(existing, invocation)
      return
    }

    const execution: ConversationExecution = { key, channelId, threadRootMessageId, agent, active: true }
    this.executions.set(key, execution)
    this.repositories.setAgentStatus(agent.id, 'busy', new Date())
    const context = this.contextAssembler.assemble({
      channelId,
      threadRootMessageId,
      currentMessageId: message.id,
      tokenBudget: conversationContextBudget,
    })
    const invocation = this.sessions.invoke({
      channelId,
      threadRootMessageId,
      currentMessageId: message.id,
      agent,
      context: this.contextAssembler.render(context),
      initialMessage: message.body,
      onSettled: (result) => this.settle(execution, result),
      onError: (error) => this.fail(execution, error.message),
    })
    this.observeInvocation(execution, invocation)
  }

  getTypingAgentIds(channelId: string): string[] {
    return [...this.executions.values()]
      .filter((execution) => execution.channelId === channelId && execution.active)
      .map((execution) => execution.agent.id)
  }

  async cancelChannel(channelId: string): Promise<void> {
    await this.cancelAndReconcile(() => this.sessions.cancelChannel(channelId))
  }

  async cancelAgentInChannel(channelId: string, agentId: string): Promise<void> {
    await this.cancelAndReconcile(() => this.sessions.cancelAgentInChannel(channelId, agentId))
  }

  private observeInvocation(execution: ConversationExecution, invocation: Promise<ConversationSessionResult>): void {
    void invocation.catch((error: unknown) => {
      if (error instanceof ConversationInvocationCancelledError) return
      this.fail(execution, error instanceof Error ? error.message : 'Runtime 启动失败')
    })
  }

  private async cancelAndReconcile(cancel: () => Promise<ConversationCancellationResult>): Promise<void> {
    try {
      const result = await cancel()
      this.finishCancelledExecutions(result.cancelledSessionKeys)
    } catch (error) {
      if (error instanceof ConversationCancellationBatchError) {
        this.finishCancelledExecutions(error.cancelledSessionKeys)
        throw error.failure
      }
      throw error
    }
  }

  private finishCancelledExecutions(cancelledSessionKeys: string[]): void {
    const cancelled = new Set(cancelledSessionKeys)
    const executions = [...this.executions.values()].filter((execution) => execution.active && cancelled.has(execution.key))
    const affectedAgentIds = new Set(executions.map((execution) => execution.agent.id))
    for (const execution of executions) {
      execution.active = false
      this.executions.delete(execution.key)
    }
    for (const agentId of affectedAgentIds) this.refreshAgentStatus(agentId)
  }

  private settle(execution: ConversationExecution, result: ConversationSessionResult): void {
    if (!execution.active) return
    execution.active = false
    this.executions.delete(execution.key)
    this.refreshAgentStatus(execution.agent.id)
    this.messages.postAgent(
      execution.channelId,
      null,
      execution.agent.identity,
      result.text || '我已处理这条消息，但没有生成可展示的回复。',
      execution.threadRootMessageId,
    )
  }

  private fail(execution: ConversationExecution, reason: string): void {
    if (!execution.active) return
    execution.active = false
    this.executions.delete(execution.key)
    this.refreshAgentStatus(execution.agent.id)
    this.messages.postAgent(execution.channelId, null, execution.agent.identity, `抱歉，我暂时无法回复：${reason}`, execution.threadRootMessageId)
  }

  private refreshAgentStatus(agentId: string): void {
    const stillActive = [...this.executions.values()].some((execution) => execution.active && execution.agent.id === agentId)
    this.repositories.setAgentStatus(agentId, stillActive ? 'busy' : 'idle', new Date())
  }

  private selectAgent(agents: Agent[], channelId: string, threadRootMessageId: string | null, body: string): Agent | undefined {
    const mentioned = mentionedAgent(agents, body)
    if (mentioned) {
      const existing = this.executions.get(conversationSessionKey(channelId, threadRootMessageId, mentioned.id))
      return mentioned.status === 'idle' || existing?.active ? mentioned : undefined
    }
    return agents
      .filter((agent) => agent.status === 'idle')
      .map((agent) => ({ agent, score: responsibilityScore(agent, body) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.agent.updatedAt.localeCompare(right.agent.updatedAt) || left.agent.id.localeCompare(right.agent.id))[0]
      ?.agent
  }

  private requireChannel(channelId: string): Channel {
    const channel = this.repositories.getChannel(channelId)
    if (channel) return channel
    throw new DomainError(`Channel ${channelId} does not exist.`)
  }
}

function exactMention(body: string, mention: string): boolean {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?=$|[^A-Za-z0-9_])`, 'i').test(body)
}

function mentionedAgent(agents: Agent[], body: string): Agent | undefined {
  return [...agents]
    .filter((agent) => exactMention(body, agent.identity))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0]
    ?? agents.find((agent) => exactMention(body, agent.mentionName))
}

function responsibilityScore(agent: Agent, body: string): number {
  const message = body.toLocaleLowerCase()
  const descriptors = [...(agent.responsibilities ?? []), ...agent.capabilityTags].map((value) => value.trim()).filter(Boolean)
  return descriptors.reduce((score, descriptor) => {
    const normalized = descriptor.toLocaleLowerCase()
    if (normalized === '通用回复' || normalized === 'general') return score + 1
    if (message.includes(normalized)) return score + 12
    const cjkMatches = intersectionSize(cjkBigrams(normalized), cjkBigrams(message))
    const wordMatches = intersectionSize(words(normalized), words(message))
    return score + (cjkMatches * 3) + wordMatches
  }, 0)
}

function cjkBigrams(value: string): Set<string> {
  const characters = [...value].filter((character) => /\p{Script=Han}/u.test(character))
  return new Set(characters.slice(1).map((character, index) => `${characters[index]}${character}`))
}

function words(value: string): Set<string> {
  return new Set(value.match(/[a-z0-9][a-z0-9_-]{1,}/gi) ?? [])
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  return [...left].filter((value) => right.has(value)).length
}
