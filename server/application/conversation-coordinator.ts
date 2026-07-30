import { randomUUID } from 'node:crypto'
import type { RuntimeKind } from '../adapters/runtime/runtime-profile'
import type { Agent } from '../domain/agent'
import type { Message } from '../domain/message'
import { DomainError } from '../domain/task'
import type { BootstrapWorkspace, WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../ports/runtime'
import { ChannelMessageService } from './channel-message-service'

export interface ConversationCoordinatorOptions {
  repositories: WorkspaceRepositories
  runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  messages?: ChannelMessageService
}

interface ConversationExecution {
  key: string
  runtimeTaskId: string
  channelId: string
  threadRootMessageId: string | null
  agent: Agent
  adapter: RuntimeAdapter
  session: RuntimeSession | null
  pendingText: string[]
  active: boolean
}

interface ChannelContext {
  workspace: BootstrapWorkspace
  repository: BootstrapWorkspace['repositories'][number]
  channel: BootstrapWorkspace['repositories'][number]['channels'][number]
}

export class ConversationCoordinator {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  private readonly messages: ChannelMessageService
  private readonly executions = new Map<string, ConversationExecution>()

  constructor(options: ConversationCoordinatorOptions) {
    this.repositories = options.repositories
    this.runtimes = options.runtimes
    this.messages = options.messages ?? new ChannelMessageService(options.repositories)
  }

  async dispatch(channelId: string, message: Message): Promise<void> {
    if (message.channelId !== channelId) throw new DomainError('Message does not belong to this channel.')

    const snapshot = this.repositories.getBootstrap()
    const context = this.requireChannelContext(snapshot.workspaces, channelId)
    const threadRootMessageId = message.threadRootMessageId ?? null
    const agents = snapshot.workspaces.flatMap((workspace) => workspace.agents)
      .filter((agent) => !context.channel.subscriberAgentIds || context.channel.subscriberAgentIds.includes(agent.id))
    const agent = this.selectAgent(agents, channelId, threadRootMessageId, message.body)
    if (!agent) return

    const agentContext = this.requireAgentContext(snapshot.workspaces, agent.id)
    const key = conversationKey(channelId, agent.id, threadRootMessageId)
    const existing = this.executions.get(key)
    if (existing?.session) {
      this.sendToExistingSession(existing, message.body)
      return
    }

    const adapter = this.runtimes[agent.runtime]
    if (!adapter) {
      this.messages.postAgent(channelId, null, agent.identity, '抱歉，我暂时无法回复：此 Agent 的 Runtime 不可用。')
      return
    }

    const execution: ConversationExecution = {
      key,
      runtimeTaskId: `conversation-${randomUUID()}`,
      channelId,
      threadRootMessageId,
      agent,
      adapter,
      session: null,
      pendingText: [],
      active: true,
    }
    this.executions.set(key, execution)
    this.repositories.setAgentStatus(agent.id, 'busy', new Date())

    try {
      execution.session = await adapter.start({
        taskId: execution.runtimeTaskId,
        mode: 'conversation',
        title: `频道 #${context.channel.name} 对话`,
        description: `${this.recentConversationContext(context.workspace, channelId, message.id, threadRootMessageId)}\n\n当前 Agent 职责：${agent.responsibilities?.join('；') || '未设置（仅处理被直接提及的消息）'}。`,
        acceptanceCriteria: '在频道中给出简洁、清晰的回复。',
        initialMessage: message.body,
        worktreePath: agentContext.repository.path,
        profile: {
          runtime: agent.runtime,
          command: agent.command,
          args: agent.args,
          model: agent.model,
          env: agent.env,
          policy: 'task-worktree',
        },
      }, (event) => this.handleRuntimeEvent(execution, event))
      if (!execution.active) adapter.cancel(execution.session)
    } catch (error) {
      this.fail(execution, error instanceof Error ? error.message : 'Runtime 启动失败')
    }
  }

  getTypingAgentIds(channelId: string): string[] {
    return [...this.executions.values()]
      .filter((execution) => execution.channelId === channelId && execution.active)
      .map((execution) => execution.agent.id)
  }

  async cancelChannel(channelId: string): Promise<void> {
    await this.cancelExecutions((execution) => execution.channelId === channelId)
  }

  async cancelAgentInChannel(channelId: string, agentId: string): Promise<void> {
    await this.cancelExecutions((execution) => execution.channelId === channelId && execution.agent.id === agentId)
  }

  private async cancelExecutions(matches: (execution: ConversationExecution) => boolean): Promise<void> {
    const executions = [...this.executions.values()].filter((execution) => execution.active && matches(execution))
    const affectedAgentIds = new Set(executions.map((execution) => execution.agent.id))
    const failures: unknown[] = []
    for (const execution of executions) {
      execution.pendingText = []
      try {
        if (execution.session) execution.adapter.cancel(execution.session)
        execution.active = false
        this.executions.delete(execution.key)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const agentId of affectedAgentIds) {
      const stillActive = [...this.executions.values()].some((execution) => execution.active && execution.agent.id === agentId)
      this.repositories.setAgentStatus(agentId, stillActive ? 'busy' : 'idle', new Date())
    }
    if (failures.length > 0) throw failures[0]
  }

  private sendToExistingSession(execution: ConversationExecution, body: string): void {
    execution.pendingText = []
    execution.active = true
    this.repositories.setAgentStatus(execution.agent.id, 'busy', new Date())
    try {
      execution.adapter.sendInput(execution.session!, body, (event) => this.handleRuntimeEvent(execution, event))
    } catch (error) {
      this.fail(execution, error instanceof Error ? error.message : 'Runtime 输入发送失败')
    }
  }

  private handleRuntimeEvent(execution: ConversationExecution, event: RuntimeEvent): void {
    if (!execution.active || event.taskId !== execution.runtimeTaskId) return
    switch (event.kind) {
      case 'text':
        execution.pendingText.push(event.text)
        return
      case 'settled':
        this.settle(execution)
        return
      case 'error':
        this.fail(execution, event.message)
        return
      case 'artifact':
      case 'tool_start':
      case 'tool_end':
      case 'queue':
      case 'session':
      case 'needs_input':
        return
    }
  }

  private settle(execution: ConversationExecution): void {
    if (!execution.active) return
    const body = execution.pendingText.join('').trim()
    execution.pendingText = []
    execution.active = false
    this.repositories.setAgentStatus(execution.agent.id, 'idle', new Date())
    this.messages.postAgent(
      execution.channelId,
      null,
      execution.agent.identity,
      body || '我已处理这条消息，但没有生成可展示的回复。',
      execution.threadRootMessageId,
    )
  }

  private fail(execution: ConversationExecution, reason: string): void {
    if (!execution.active) return
    execution.pendingText = []
    execution.active = false
    this.executions.delete(execution.key)
    this.repositories.setAgentStatus(execution.agent.id, 'idle', new Date())
    this.messages.postAgent(execution.channelId, null, execution.agent.identity, `抱歉，我暂时无法回复：${reason}`, execution.threadRootMessageId)
  }

  private selectAgent(agents: Agent[], channelId: string, threadRootMessageId: string | null, body: string): Agent | undefined {
    const mentioned = mentionedAgent(agents, body)
    if (mentioned) {
      const existing = this.executions.get(conversationKey(channelId, mentioned.id, threadRootMessageId))
      return mentioned.status === 'idle' || existing?.active ? mentioned : undefined
    }
    return agents
      .filter((agent) => agent.status === 'idle')
      .map((agent) => ({ agent, score: responsibilityScore(agent, body) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.agent.updatedAt.localeCompare(right.agent.updatedAt) || left.agent.id.localeCompare(right.agent.id))[0]
      ?.agent
  }

  private requireChannelContext(workspaces: BootstrapWorkspace[], channelId: string): ChannelContext {
    for (const workspace of workspaces) {
      for (const repository of workspace.repositories) {
        const channel = repository.channels.find((candidate) => candidate.id === channelId)
        if (channel) return { workspace, repository, channel }
      }
    }
    throw new DomainError(`Channel ${channelId} does not exist.`)
  }

  private requireAgentContext(workspaces: BootstrapWorkspace[], agentId: string): { workspace: BootstrapWorkspace; repository: BootstrapWorkspace['repositories'][number] } {
    for (const workspace of workspaces) {
      if (!workspace.agents.some((agent) => agent.id === agentId)) continue
      const repository = workspace.repositories[0]
      if (repository) return { workspace, repository }
    }
    throw new DomainError(`Agent ${agentId} does not have a workspace repository.`)
  }

  private recentConversationContext(workspace: BootstrapWorkspace, channelId: string, currentMessageId: string, threadRootMessageId: string | null): string {
    const history = workspace.recentMessages
      .filter((message) => message.channelId === channelId && message.id !== currentMessageId)
      .filter((message) => !threadRootMessageId || message.id === threadRootMessageId || message.threadRootMessageId === threadRootMessageId)
      .slice(-8)
      .map((message) => `${message.authorName}: ${compactContextBody(message.body)}`)
    return history.join('\n') || '（频道尚无此前消息。）'
  }
}

function compactContextBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized
}

function conversationKey(channelId: string, agentId: string, threadRootMessageId: string | null): string {
  return `${channelId}:${threadRootMessageId ?? 'timeline'}:${agentId}`
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
