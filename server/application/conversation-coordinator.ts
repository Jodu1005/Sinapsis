import type { RuntimeKind } from '../adapters/runtime/runtime-profile'
import type { Message } from '../domain/message'
import { DomainError } from '../domain/task'
import type { WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter } from '../ports/runtime'
import { ChannelMessageService } from './channel-message-service'
import { ChannelTurnCoordinator } from './channel-turn-coordinator'
import { ContextAssembler } from './context-assembler'
import { ConversationSessionService } from './conversation-session-service'

export interface ConversationCoordinatorOptions {
  repositories?: WorkspaceRepositories
  runtimes?: Partial<Record<RuntimeKind, RuntimeAdapter>>
  conversationDirectory?: string
  messages?: ChannelMessageService
  sessions?: ConversationSessionService
  contextAssembler?: ContextAssembler
  turnCoordinator?: ChannelTurnCoordinator
}

export class ConversationCoordinator {
  private readonly turnCoordinator: ChannelTurnCoordinator

  constructor(options: ConversationCoordinatorOptions) {
    if (options.turnCoordinator) {
      this.turnCoordinator = options.turnCoordinator
      return
    }
    if (!options.repositories) throw new Error('Conversation repositories are required.')
    this.turnCoordinator = new ChannelTurnCoordinator({
      repositories: options.repositories,
      runtimes: options.runtimes,
      conversationDirectory: options.conversationDirectory,
      messages: options.messages,
      sessions: options.sessions,
      contextAssembler: options.contextAssembler,
    })
  }

  async dispatch(channelId: string, message: Message): Promise<void> {
    if (message.channelId !== channelId) throw new DomainError('Message does not belong to this channel.')
    await this.turnCoordinator.dispatch(message)
  }

  getTypingAgentIds(channelId: string): string[] {
    return [...new Set(this.turnCoordinator.getActiveStates(channelId)
      .flatMap((activity) => activity.agentId ? [activity.agentId] : []))]
  }

  async cancelChannel(channelId: string): Promise<void> {
    await this.turnCoordinator.cancelChannel(channelId)
  }

  async cancelAgentInChannel(channelId: string, agentId: string): Promise<void> {
    await this.turnCoordinator.cancelAgentInChannel(channelId, agentId)
  }
}
