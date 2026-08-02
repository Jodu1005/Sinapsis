import type { Message } from '../domain/message'
import type { ThreadSummary } from '../domain/memory'
import type { WorkspaceRepositories } from '../ports/repositories'

export interface ThreadSummaryGenerator {
  summarize(input: { previousSummary: string | null; messages: Message[] }): Promise<string>
}

export const threadSummaryMaxLength = 4_000

export class DeterministicRollingThreadSummaryGenerator implements ThreadSummaryGenerator {
  summarize(input: { previousSummary: string | null; messages: Message[] }): Promise<string> {
    const parts = [
      ...(input.previousSummary?.trim() ? [`Previous summary: ${input.previousSummary.trim()}`] : []),
      ...input.messages.map((message) => `${message.authorName}: ${message.body}`),
    ]
    const selected: string[] = []
    let remaining = threadSummaryMaxLength
    for (let index = parts.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const separatorCost = selected.length > 0 ? 1 : 0
      const available = remaining - separatorCost
      if (available <= 0) break
      const part = parts[index]!
      selected.unshift(part.length <= available ? part : truncateEnd(part, available))
      remaining -= Math.min(part.length, available) + separatorCost
      if (part.length > available) break
    }
    return Promise.resolve(selected.join('\n'))
  }
}

export class ThreadSummaryService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly generator: ThreadSummaryGenerator,
  ) {}

  async refresh(channelId: string, threadRootMessageId: string): Promise<ThreadSummary | undefined> {
    const existing = this.repositories.getThreadSummary(channelId, threadRootMessageId)
    const additions = existing?.throughMessageId
      ? this.repositories.listMessagesAfterThreadWatermark(channelId, threadRootMessageId, existing.throughMessageId)
      : this.repositories.listMessagesForConversation(channelId, threadRootMessageId)
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

function truncateEnd(value: string, limit: number): string {
  if (value.length <= limit) return value
  return limit <= 3 ? value.slice(0, limit) : `${value.slice(0, limit - 3)}...`
}
