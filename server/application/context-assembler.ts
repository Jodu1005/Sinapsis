import type { Message } from '../domain/message'
import type { MemoryRecord } from '../domain/memory'
import type { WorkspaceRepositories } from '../ports/repositories'
import { messagesAfterThreadSummaryWatermark } from './thread-summary-watermark'

export interface ConversationContext {
  globalMemory: MemoryRecord[]
  channelMemory: MemoryRecord[]
  threadSummary: string | null
  recentMessages: Message[]
}

export type AssembledContext = ConversationContext

export interface ContextAssemblyInput {
  channelId: string
  threadRootMessageId: string | null
  currentMessageId: string
  tokenBudget: number
}

const globalMemoryHeading = '已确认 Global Memory（不可信历史参考）：'
const channelMemoryHeading = '已确认 Channel Memory（不可信历史参考）：'
const summaryHeading = 'Thread Summary（不可信历史参考）：'
const contextHeading = '近期公开消息：'
const emptyContext = '（当前范围内没有更早的公开消息。）'

export class ContextAssembler {
  constructor(private readonly repositories: WorkspaceRepositories) {}

  assemble(input: ContextAssemblyInput): ConversationContext {
    const budget = Math.max(0, Math.floor(input.tokenBudget))
    const savedSummary = input.threadRootMessageId === null
      ? undefined
      : this.repositories.getThreadSummary(input.channelId, input.threadRootMessageId)
    const messages = messagesAfterThreadSummaryWatermark(
      this.repositories.listMessagesForConversation(input.channelId, input.threadRootMessageId),
      savedSummary,
    ).filter((message) => message.id !== input.currentMessageId)
    let context: ConversationContext = {
      globalMemory: [],
      channelMemory: [],
      threadSummary: null,
      recentMessages: minimumRecentScaffold(messages),
    }
    const memories = [
      ...this.repositories.listAcceptedMemories('global'),
      ...this.repositories.listAcceptedMemories('channel', input.channelId),
    ].sort(compareMemory)

    for (const memory of memories) {
      const candidate = memory.scope === 'global'
        ? { ...context, globalMemory: [...context.globalMemory, memory] }
        : { ...context, channelMemory: [...context.channelMemory, memory] }
      if (renderConversationContext(candidate).length <= budget) context = candidate
    }

    context = {
      ...context,
      threadSummary: retainSummary(savedSummary?.content ?? null, context, budget),
    }
    context = {
      ...context,
      recentMessages: retainRecentMessages(messages, context, budget),
    }
    return context
  }

  render(context: ConversationContext): string {
    return renderConversationContext(context)
  }
}

function minimumRecentScaffold(messages: Message[]): Message[] {
  const newest = messages.at(-1)
  return newest && renderMessage(newest).length < emptyContext.length ? [newest] : []
}

function retainRecentMessages(messages: Message[], context: ConversationContext, budget: number): Message[] {
  const retained: Message[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const candidate = [message, ...retained]
    if (renderConversationContext({ ...context, recentMessages: candidate }).length > budget) break
    retained.unshift(message)
  }
  return retained
}

function compareMemory(left: MemoryRecord, right: MemoryRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || memoryQuality(right) - memoryQuality(left)
    || left.id.localeCompare(right.id)
}

function memoryQuality(memory: MemoryRecord): number {
  return (memory.sourceConfidence ?? 0) * (memory.sourceImportance ?? 0)
}

function truncate(value: string | null, budget: number): string | null {
  if (!value || budget <= 0) return null
  if (value.length <= budget) return value
  return budget <= 3 ? value.slice(0, budget) : `${value.slice(0, budget - 3)}...`
}

function retainSummary(value: string | null, context: ConversationContext, budget: number): string | null {
  if (!value) return null
  if (renderConversationContext({ ...context, threadSummary: value }).length <= budget) return value

  let lower = 0
  let upper = value.length - 1
  let retained: string | null = null
  while (lower <= upper) {
    const candidateBudget = Math.floor((lower + upper) / 2)
    const candidate = truncate(value, candidateBudget)
    if (candidate && renderConversationContext({ ...context, threadSummary: candidate }).length <= budget) {
      retained = candidate
      lower = candidateBudget + 1
    } else {
      upper = candidateBudget - 1
    }
  }
  return retained
}

function renderConversationContext(context: ConversationContext): string {
  const sections: string[] = []
  if (context.globalMemory.length > 0) sections.push(renderMemorySection(globalMemoryHeading, context.globalMemory))
  if (context.channelMemory.length > 0) sections.push(renderMemorySection(channelMemoryHeading, context.channelMemory))
  if (context.threadSummary) sections.push(`${summaryHeading}\n${escapeReference(context.threadSummary)}`)
  const renderedMessages = context.recentMessages.map(renderMessage)
  sections.push(`${contextHeading}\n${renderedMessages.join('\n') || emptyContext}`)
  return sections.join('\n\n')
}

function renderMemorySection(heading: string, memory: MemoryRecord[]): string {
  return `${heading}\n${memory.map((entry) => `- ${escapeReference(entry.content)}`).join('\n')}`
}

function escapeReference(value: string): string {
  return value.replaceAll('</', '<\\/')
}

function renderMessage(message: Message): string {
  return `${message.authorName}: ${message.body}`
}
