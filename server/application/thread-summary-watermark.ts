import type { Message } from '../domain/message'
import type { ThreadSummary } from '../domain/memory'

export function messagesAfterThreadSummaryWatermark(
  messages: Message[],
  summary: ThreadSummary | undefined,
): Message[] {
  if (!summary?.throughMessageCreatedAt || !summary.throughMessageId) return messages
  const throughMessageCreatedAt = summary.throughMessageCreatedAt
  const throughMessageId = summary.throughMessageId

  const watermarkIndex = messages.findIndex((message) => message.id === throughMessageId)
  if (watermarkIndex >= 0) return messages.slice(watermarkIndex + 1)

  return messages.filter((message) => (
    message.createdAt > throughMessageCreatedAt
    || (message.createdAt === throughMessageCreatedAt && message.id > throughMessageId)
  ))
}
