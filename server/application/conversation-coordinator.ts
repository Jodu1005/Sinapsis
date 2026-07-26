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

    const context = this.requireChannelContext(channelId)
    const agent = this.selectAgent(context.workspace, channelId, message.body)
    if (!agent) throw new DomainError('No idle Agent is available for this channel.')

    const key = conversationKey(channelId, agent.id)
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
        description: this.recentChannelContext(context.workspace, channelId, message.id),
        acceptanceCriteria: '在频道中给出简洁、清晰的回复。',
        initialMessage: message.body,
        worktreePath: context.repository.path,
        profile: {
          runtime: agent.runtime,
          command: agent.command,
          args: agent.args,
          model: agent.model,
          env: agent.env,
          policy: 'task-worktree',
        },
      }, (event) => this.handleRuntimeEvent(execution, event))
    } catch (error) {
      this.fail(execution, error instanceof Error ? error.message : 'Runtime 启动失败')
    }
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
    )
  }

  private fail(execution: ConversationExecution, reason: string): void {
    if (!execution.active) return
    execution.pendingText = []
    execution.active = false
    this.executions.delete(execution.key)
    this.repositories.setAgentStatus(execution.agent.id, 'idle', new Date())
    this.messages.postAgent(execution.channelId, null, execution.agent.identity, `抱歉，我暂时无法回复：${reason}`)
  }

  private selectAgent(workspace: BootstrapWorkspace, channelId: string, body: string): Agent | undefined {
    const mentioned = mentionedAgent(workspace.agents, body)
    if (mentioned) {
      const existing = this.executions.get(conversationKey(channelId, mentioned.id))
      return mentioned.status === 'idle' || existing?.active ? mentioned : undefined
    }
    return workspace.agents
      .filter((agent) => agent.status === 'idle')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))[0]
  }

  private requireChannelContext(channelId: string): ChannelContext {
    for (const workspace of this.repositories.getBootstrap().workspaces) {
      for (const repository of workspace.repositories) {
        const channel = repository.channels.find((candidate) => candidate.id === channelId)
        if (channel) return { workspace, repository, channel }
      }
    }
    throw new DomainError(`Channel ${channelId} does not exist.`)
  }

  private recentChannelContext(workspace: BootstrapWorkspace, channelId: string, currentMessageId: string): string {
    const history = workspace.recentMessages
      .filter((message) => message.channelId === channelId && message.id !== currentMessageId)
      .slice(-8)
      .map((message) => `${message.authorName}: ${compactContextBody(message.body)}`)
    return history.join('\n') || '（频道尚无此前消息。）'
  }
}

function compactContextBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized
}

function conversationKey(channelId: string, agentId: string): string {
  return `${channelId}:${agentId}`
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
