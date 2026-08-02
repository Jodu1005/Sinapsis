import type { Message } from '../domain/message'
import type { ThreadSummary } from '../domain/memory'
import type { WorkspaceRepositories } from '../ports/repositories'
import { messagesAfterThreadSummaryWatermark } from './thread-summary-watermark'

export interface ThreadSummaryGenerator {
  summarize(input: { previousSummary: string | null; messages: Message[] }): Promise<string>
}

export class ThreadSummaryService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly generator: ThreadSummaryGenerator,
  ) {}

  async refresh(channelId: string, threadRootMessageId: string): Promise<ThreadSummary | undefined> {
    const existing = this.repositories.getThreadSummary(channelId, threadRootMessageId)
    const messages = this.repositories.listMessagesForConversation(channelId, threadRootMessageId)
    const additions = messagesAfterThreadSummaryWatermark(messages, existing)
    if (additions.length === 0) return existing

    try {
      const content = await this.generator.summarize({ previousSummary: existing?.content ?? null, messages: additions })
      const through = additions.at(-1)!
      return this.repositories.upsertThreadSummary({
        channelId,
        threadRootMessageId,
        content,
        throughMessageCreatedAt: through.createdAt,
        throughMessageId: through.id,
      })
    } catch {
      return existing
    }
  }
}
