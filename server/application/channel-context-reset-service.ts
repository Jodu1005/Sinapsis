import { getChannelCapabilities } from '../../shared/channel-policy'
import { DomainError, type Task } from '../domain/task'
import type { Channel } from '../domain/workspace'
import type { WorkspaceRepositories } from '../ports/repositories'

interface ChannelConversationCanceller {
  cancelChannel(channelId: string): Promise<void>
}

interface TaskCanceller {
  cancelTask(taskId: string, reason: string): Promise<Task>
}

const terminalTaskStatuses = new Set(['completed', 'accepted', 'merged', 'cancelled'])

export class ChannelContextResetService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly conversations: ChannelConversationCanceller,
    private readonly tasks: TaskCanceller,
  ) {}

  async reset(channelId: string): Promise<Channel> {
    const channel = this.repositories.getChannel(channelId)
    if (!channel) throw new DomainError(`Channel ${channelId} does not exist.`)
    if (channel.archivedAt) throw new DomainError(`Archived channel #${channel.name} cannot reset its context.`)
    const systemKey = (channel as Channel & { systemKey?: string | null }).systemKey
    if (!getChannelCapabilities(systemKey).resetContext) throw new DomainError(`Only #summit can reset channel context.`)

    await this.conversations.cancelChannel(channelId)
    const activeTasks = this.repositories.getTasksForChannel(channelId)
      .filter((task) => !terminalTaskStatuses.has(task.status))
    await Promise.all(activeTasks.map((task) => this.tasks.cancelTask(task.id, '频道上下文已清空')))

    return this.repositories.resetChannelContext(channelId, new Date())
  }
}
