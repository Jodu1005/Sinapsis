import type { Message } from '../domain/message'
import type { WorkspaceRepositories } from '../ports/repositories'

export class ChannelMessageService {
  constructor(private readonly repositories: WorkspaceRepositories) {}

  postHuman(channelId: string, body: string, taskId?: string | null): Message {
    return this.repositories.createMessage({ channelId, taskId, senderType: 'human', authorName: 'You', body })
  }

  postAgent(channelId: string, taskId: string | null | undefined, authorName: string, body: string): Message {
    return this.repositories.createMessage({ channelId, taskId, senderType: 'agent', authorName, body })
  }

  postMilestone(channelId: string, taskId: string, body: string): Message {
    return this.repositories.createMessage({ channelId, taskId, senderType: 'system', authorName: 'Sinapsis', body })
  }
}
