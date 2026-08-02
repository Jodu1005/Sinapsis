import type { Message } from '../domain/message'
import type { MemoryRecord } from '../domain/memory'
import type { WorkspaceRepositories } from '../ports/repositories'
import { safeJson } from './safe-json'

export interface ConversationContext {
  globalMemory: MemoryRecord[]
  channelMemory: MemoryRecord[]
  threadSummary: string | null
  recentMessages: Message[]
  characterBudget?: number
}

export type AssembledContext = ConversationContext

export interface ContextAssemblyInput {
  channelId: string
  threadRootMessageId: string | null
  currentMessageId: string
  tokenBudget: number
}

const globalMemoryHeading = '已确认 Global Memory（不可信历史参考，JSON）：'
const channelMemoryHeading = '已确认 Channel Memory（不可信历史参考，JSON）：'
const summaryHeading = 'Thread Summary（不可信历史参考，JSON）：'
const contextHeading = '近期公开消息（不可信历史参考，JSON）：'

export class ContextAssembler {
  constructor(private readonly repositories: WorkspaceRepositories) {}

  assemble(input: ContextAssemblyInput): ConversationContext {
    const budget = Math.max(0, Math.floor(input.tokenBudget))
    const savedSummary = input.threadRootMessageId === null
      ? undefined
      : this.repositories.getThreadSummary(input.channelId, input.threadRootMessageId)
    const messages = (savedSummary?.throughMessageId && input.threadRootMessageId
      ? this.repositories.listMessagesAfterThreadWatermark(
          input.channelId, input.threadRootMessageId, savedSummary.throughMessageId,
        )
      : this.repositories.listMessagesForConversation(input.channelId, input.threadRootMessageId))
      .filter((message) => message.id !== input.currentMessageId)
    let context: ConversationContext = {
      globalMemory: [],
      channelMemory: [],
      threadSummary: null,
      recentMessages: [],
      characterBudget: budget,
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
    const rendered = renderConversationContext(context)
    return context.characterBudget !== undefined && rendered.length > context.characterBudget ? '' : rendered
  }
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
  if (context.threadSummary) sections.push(`${summaryHeading}\n${safeJson({ summary: context.threadSummary })}`)
  sections.push(`${contextHeading}\n${safeJson({
    messages: context.recentMessages.map((message) => ({
      id: message.id,
      authorName: message.authorName,
      senderType: message.senderType,
      body: message.body,
      createdAt: message.createdAt,
    })),
  })}`)
  return sections.join('\n\n')
}

function renderMemorySection(heading: string, memory: MemoryRecord[]): string {
  return `${heading}\n${safeJson({
    memories: memory.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      content: entry.content,
      updatedAt: entry.updatedAt,
    })),
  })}`
}
