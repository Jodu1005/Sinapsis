import type { Message } from '../domain/message'
import type { WorkspaceRepositories } from '../ports/repositories'

export interface AssembledContext {
  recentMessages: Message[]
}

export interface ContextAssemblyInput {
  channelId: string
  threadRootMessageId: string | null
  currentMessageId: string
  tokenBudget: number
}

const contextHeading = '近期公开消息：'
const emptyContext = '（当前范围内没有更早的公开消息。）'

export class ContextAssembler {
  constructor(private readonly repositories: WorkspaceRepositories) {}

  assemble(input: ContextAssemblyInput): AssembledContext {
    const messages = this.repositories.listMessagesForConversation(input.channelId, input.threadRootMessageId)
      .filter((message) => message.id !== input.currentMessageId)
    const budget = Math.max(0, Math.floor(input.tokenBudget))
    const retained: Message[] = []
    let used = 0

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      const cost = renderMessage(message).length + (retained.length > 0 ? 1 : 0)
      if (used + cost > budget) break
      retained.unshift(message)
      used += cost
    }

    return { recentMessages: retained }
  }

  render(context: AssembledContext): string {
    const renderedMessages = context.recentMessages.map(renderMessage)
    return `${contextHeading}\n${renderedMessages.join('\n') || emptyContext}`
  }
}

function renderMessage(message: Message): string {
  return `${message.authorName}: ${message.body}`
}
