import { getChannelCapabilities } from '../../shared/channel-policy'
import type { Agent } from '../domain/agent'
import { DomainError } from '../domain/task'
import type { WorkspaceRepositories } from '../ports/repositories'
import { NotFoundError } from './workspace-service'

interface ChannelAgentConversationCanceller {
  cancelAgentInChannel(channelId: string, agentId: string): Promise<void>
}

export class ChannelMembershipService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly conversations: ChannelAgentConversationCanceller,
  ) {}

  list(channelId: string): Agent[] {
    this.requireChannel(channelId)
    return this.repositories.getChannelAgentIds(channelId)
      .map((agentId) => this.repositories.getAgent(agentId))
      .filter((agent): agent is Agent => agent !== undefined)
  }

  add(channelId: string, agentId: string, actor: 'human'): Agent[] {
    this.requireHuman(actor)
    const channel = this.requireMutableChannel(channelId)
    this.requireAgent(agentId)
    this.repositories.addChannelAgent(channel.id, agentId, new Date())
    return this.list(channel.id)
  }

  async remove(channelId: string, agentId: string, actor: 'human'): Promise<Agent[]> {
    this.requireHuman(actor)
    const channel = this.requireMutableChannel(channelId)
    this.requireAgent(agentId)
    if (!channel.memberAgentIds.includes(agentId)) return this.list(channel.id)

    const hasUnfinishedTask = channel.boundWorkspaceIds.some((workspaceId) =>
      this.repositories.hasUnfinishedTask(channel.id, workspaceId, agentId),
    )
    if (hasUnfinishedTask) {
      throw new DomainError(`Agent ${agentId} has an unfinished task in this channel.`)
    }

    await this.conversations.cancelAgentInChannel(channel.id, agentId)
    this.repositories.removeChannelAgent(channel.id, agentId)
    return this.list(channel.id)
  }

  private requireChannel(channelId: string) {
    const channel = this.repositories.getChannel(channelId)
    if (!channel) throw new NotFoundError(`Channel ${channelId} does not exist.`)
    return channel
  }

  private requireMutableChannel(channelId: string) {
    const channel = this.requireChannel(channelId)
    if (!getChannelCapabilities(channel.systemKey).mutableMembership) {
      throw new DomainError('summit membership is automatic.')
    }
    return channel
  }

  private requireAgent(agentId: string): Agent {
    const agent = this.repositories.getAgent(agentId)
    if (!agent) throw new NotFoundError(`Agent ${agentId} does not exist.`)
    return agent
  }

  private requireHuman(actor: 'human'): void {
    if (actor !== 'human') throw new DomainError('Only a human can manage channel membership.')
  }
}
