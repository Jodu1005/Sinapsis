import type { Message } from '../domain/message'
import type { ThreadSummary } from '../domain/memory'
import type { WorkspaceRepositories } from '../ports/repositories'

export interface ThreadSummaryGenerator {
  summarize(input: { previousSummary: string | null; messages: Message[]; signal: AbortSignal }): Promise<string>
}

export const threadSummaryMaxLength = 4_000
export const threadSummaryDefaultTimeoutMs = 5_000

export interface ThreadSummaryServiceOptions {
  timeoutMs?: number
}

export class DeterministicRollingThreadSummaryGenerator implements ThreadSummaryGenerator {
  summarize(input: { previousSummary: string | null; messages: Message[]; signal: AbortSignal }): Promise<string> {
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
  private readonly timeoutMs: number
  private readonly inFlight = new Map<string, { controller: AbortController; promise: Promise<ThreadSummary | undefined> }>()

  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly generator: ThreadSummaryGenerator,
    options: ThreadSummaryServiceOptions = {},
  ) {
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? threadSummaryDefaultTimeoutMs))
  }

  refresh(channelId: string, threadRootMessageId: string): Promise<ThreadSummary | undefined> {
    const key = JSON.stringify([channelId, threadRootMessageId])
    const active = this.inFlight.get(key)
    if (active) return active.promise

    const controller = new AbortController()
    const operation = this.runRefresh(channelId, threadRootMessageId, controller)
    const promise = operation.finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key)
    })
    this.inFlight.set(key, { controller, promise })
    return promise
  }

  cancel(channelId: string, threadRootMessageId: string): void {
    this.inFlight.get(JSON.stringify([channelId, threadRootMessageId]))?.controller.abort()
  }

  private async runRefresh(
    channelId: string,
    threadRootMessageId: string,
    controller: AbortController,
  ): Promise<ThreadSummary | undefined> {
    const existing = this.repositories.getThreadSummary(channelId, threadRootMessageId)
    const additions = existing?.throughMessageId
      ? this.repositories.listMessagesAfterThreadWatermark(channelId, threadRootMessageId, existing.throughMessageId)
      : this.repositories.listMessagesForConversation(channelId, threadRootMessageId)
    if (additions.length === 0) return existing

    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    timeout.unref?.()
    try {
      const content = await waitForAbort(this.generator.summarize({
        previousSummary: existing?.content ?? null,
        messages: additions,
        signal: controller.signal,
      }), controller.signal)
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
    } finally {
      clearTimeout(timeout)
    }
  }
}

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Thread Summary maintenance aborted.'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(new Error('Thread Summary maintenance aborted.'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function truncateEnd(value: string, limit: number): string {
  if (value.length <= limit) return value
  return limit <= 3 ? value.slice(0, limit) : `${value.slice(0, limit - 3)}...`
}
