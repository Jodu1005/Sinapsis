import type { Message } from '../domain/message'
import type { WorkspaceRepositories } from '../ports/repositories'

export type ChannelMessageRepository = Pick<WorkspaceRepositories, 'createMessage'>

export class ChannelMessageService {
  constructor(private readonly repositories: ChannelMessageRepository) {}

  postHuman(channelId: string, body: string, taskId?: string | null, threadRootMessageId?: string | null): Message {
    return this.repositories.createMessage({ channelId, taskId, threadRootMessageId, senderType: 'human', authorName: 'You', body })
  }

  postAgent(channelId: string, taskId: string | null | undefined, agentId: string, authorName: string, body: string, threadRootMessageId?: string | null): Message {
    return this.repositories.createMessage({
      channelId, taskId, threadRootMessageId, senderType: 'agent', senderId: agentId, authorName, body,
    })
  }

  postMilestone(channelId: string, taskId: string, body: string, threadRootMessageId?: string | null): Message {
    return this.repositories.createMessage({ channelId, taskId, threadRootMessageId, senderType: 'system', authorName: 'Sinapsis', body })
  }
}
