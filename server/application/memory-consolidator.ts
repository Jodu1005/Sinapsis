import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeProfile } from '../adapters/runtime/runtime-profile'
import type { MemoryCandidate, MemoryRecord, CreateMemoryCandidateInput } from '../domain/memory'
import type { Message } from '../domain/message'
import type { Channel } from '../domain/workspace'
import type { ConversationTurnDetails } from '../ports/repositories'
import type { RuntimeAdapter, RuntimeArtifactType, RuntimeEvent, RuntimeSession, RuntimeTaskRequest } from '../ports/runtime'
import { memoryContentHash, parseMemoryConsolidation, type ProposedMemory } from './memory-consolidation-protocol'

export interface MemoryConsolidationRepositories {
  createMemoryCandidates(inputs: CreateMemoryCandidateInput[]): MemoryCandidate[]
}

export interface MemoryConsolidatorOptions {
  repositories: MemoryConsolidationRepositories
  runtime: RuntimeAdapter
  dataDir: string
  profile: RuntimeProfile
  timeoutMs: number
  maxCandidates: number
}

export interface MemoryConsolidationInput {
  runId: string
  channel: Channel
  messages: Message[]
  turns: ConversationTurnDetails[]
  acceptedMemories: MemoryRecord[]
}

export class MemoryConsolidator {
  private readonly repositories: MemoryConsolidationRepositories
  private readonly runtime: RuntimeAdapter
  private readonly dataDir: string
  private readonly profile: RuntimeProfile
  private readonly timeoutMs: number
  private readonly maxCandidates: number

  constructor(options: MemoryConsolidatorOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error('MemoryConsolidator timeoutMs must be a positive integer.')
    }
    if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 50) {
      throw new Error('MemoryConsolidator maxCandidates must be an integer from 1 through 50.')
    }
    this.repositories = options.repositories
    this.runtime = options.runtime
    this.dataDir = options.dataDir
    this.profile = options.profile
    this.timeoutMs = options.timeoutMs
    this.maxCandidates = options.maxCandidates
  }

  async consolidate(input: MemoryConsolidationInput): Promise<MemoryCandidate[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId)) {
      throw new Error('Dream runId must contain only safe letters, numbers, hyphens, and underscores.')
    }
    const crossChannelMessage = input.messages.find((message) => message.channelId !== input.channel.id)
    if (crossChannelMessage) {
      throw new Error(`Message ${crossChannelMessage.id} does not belong to channel ${input.channel.id}.`)
    }
    const crossChannelTurn = input.turns.find((details) => details.turn.channelId !== input.channel.id)
    if (crossChannelTurn) {
      throw new Error(`Turn ${crossChannelTurn.turn.id} does not belong to channel ${input.channel.id}.`)
    }
    for (const details of input.turns) {
      const foreignInvocation = details.invocations.find((invocation) => invocation.turnId !== details.turn.id)
      if (foreignInvocation) {
        throw new Error(
          `Invocation ${foreignInvocation.id} belongs to turn ${foreignInvocation.turnId}, not ${details.turn.id}.`,
        )
      }
    }

    const runDirectory = path.join(this.dataDir, 'dream', input.runId)
    await mkdir(runDirectory, { recursive: true })

    const publicMessages = input.messages.filter((message) => message.deletedAt === null)
    const acceptedMemories = relevantAcceptedMemories(input.acceptedMemories, input.channel.id)
    const request = runtimeRequest(input, publicMessages, acceptedMemories, runDirectory, this.profile)
    const text: string[] = []
    const artifacts = new Map<RuntimeArtifactType, string[]>()
    let session: RuntimeSession | undefined
    let cancelWhenStarted = false
    let terminal = false
    let resolveOutcome!: (outcome: RuntimeOutcome) => void
    const outcomePromise = new Promise<RuntimeOutcome>((resolve) => { resolveOutcome = resolve })

    const finish = (outcome: RuntimeOutcome, cancel: boolean): void => {
      if (terminal) return
      terminal = true
      if (cancel) {
        if (session) outcome = cancelOutcome(this.runtime, session, outcome)
        else cancelWhenStarted = true
      }
      resolveOutcome(outcome)
    }
    const sink = (event: RuntimeEvent): void => {
      if (event.taskId !== input.runId || terminal) return
      switch (event.kind) {
        case 'text':
          text.push(event.text)
          return
        case 'artifact': {
          const chunks = artifacts.get(event.artifactType) ?? []
          chunks.push(event.content)
          artifacts.set(event.artifactType, chunks)
          return
        }
        case 'error':
          finish({ kind: 'error', error: new Error(`Dream Runtime failed: ${event.message}`) }, true)
          return
        case 'settled':
          finish({ kind: 'settled', raw: text.join('').trim() }, true)
          return
        case 'session':
        case 'tool_start':
        case 'tool_end':
        case 'queue':
        case 'needs_input':
          return
      }
    }

    const timeout = setTimeout(() => {
      finish({ kind: 'error', error: new Error(`Dream Runtime timed out after ${this.timeoutMs}ms.`) }, true)
    }, this.timeoutMs)
    timeout.unref?.()

    const acceptSession = (startedSession: RuntimeSession): void => {
      session = startedSession
      if (!cancelWhenStarted) return
      try {
        this.runtime.cancel(startedSession)
      } catch {
        // The already-recorded Runtime error remains the primary diagnostic.
      }
    }
    try {
      void this.runtime.start(request, sink).then(
        acceptSession,
        (error: unknown) => finish({
          kind: 'error',
          error: new Error(`Dream Runtime failed to start: ${errorMessage(error)}.`),
        }, false),
      )
    } catch (error) {
      finish({ kind: 'error', error: new Error(`Dream Runtime failed to start: ${errorMessage(error)}.`) }, false)
    }

    let outcome: RuntimeOutcome
    try {
      outcome = await outcomePromise
    } finally {
      clearTimeout(timeout)
      await persistArtifacts(runDirectory, artifacts)
    }
    if (outcome.kind === 'error') throw outcome.error

    const parsed = parseMemoryConsolidation(
      outcome.raw,
      publicMessages.map((message) => message.id),
      this.maxCandidates,
    )
    return this.persistCandidates(input, parsed.candidates, acceptedMemories)
  }

  private persistCandidates(
    input: MemoryConsolidationInput,
    proposed: ProposedMemory[],
    acceptedMemories: MemoryRecord[],
  ): MemoryCandidate[] {
    const accepted = acceptedMemories.map((memory) => ({
      memory,
      hash: memoryContentHash(memory.content),
      subjectKey: memorySubjectKey(memory.content),
    }))
    const inputs: CreateMemoryCandidateInput[] = []
    const proposedKeys = new Set<string>()

    for (const candidate of proposed) {
      const hash = memoryContentHash(candidate.content)
      const proposalKey = `${candidate.scope}:${candidate.scope === 'channel' ? input.channel.id : ''}:${hash}`
      if (proposedKeys.has(proposalKey)) continue
      proposedKeys.add(proposalKey)
      if (accepted.some((item) => item.memory.scope === candidate.scope && item.hash === hash)) continue

      const conflict = accepted.find((item) =>
        item.memory.scope === candidate.scope
        && item.memory.kind === candidate.kind
        && item.hash !== hash
        && item.subjectKey !== undefined
        && item.subjectKey === memorySubjectKey(candidate.content))
      const rationale = conflict
        ? `${candidate.rationale} Potential conflict with accepted Memory ${conflict.memory.id}; human review required.`
        : candidate.rationale
      inputs.push({
        dreamRunId: input.runId,
        proposedScope: candidate.scope,
        channelId: candidate.scope === 'channel' ? input.channel.id : null,
        kind: candidate.kind,
        proposedContent: candidate.content,
        rationale,
        confidence: candidate.confidence,
        importance: candidate.importance,
        sourceMessageIds: candidate.sourceMessageIds,
      })
    }
    return this.repositories.createMemoryCandidates(inputs)
  }
}

type RuntimeOutcome =
  | { kind: 'settled'; raw: string; error?: never }
  | { kind: 'error'; error: Error }

function runtimeRequest(
  input: MemoryConsolidationInput,
  messages: Message[],
  acceptedMemories: MemoryRecord[],
  runDirectory: string,
  profile: RuntimeProfile,
): RuntimeTaskRequest {
  return {
    taskId: input.runId,
    mode: 'conversation',
    title: `Dream memory consolidation for #${input.channel.name}`,
    description: JSON.stringify({
      instruction: 'Extract only durable, confirmed memories. Return exactly one JSON object with a candidates array that follows the Memory consolidation protocol.',
      channel: { id: input.channel.id, name: input.channel.name },
      messages: messages.map((message) => ({
        id: message.id,
        authorName: message.authorName,
        body: message.body,
        createdAt: message.createdAt,
      })),
      turnPublicResults: publicTurnResults(input.turns),
      acceptedMemories: acceptedMemories.map((memory) => ({
        scope: memory.scope,
        kind: memory.kind,
        content: memory.content,
      })),
    }),
    acceptanceCriteria: 'Return only the strict JSON Memory consolidation result. Do not include Markdown or explanatory text.',
    worktreePath: runDirectory,
    profile,
    executionPolicy: 'read-only-no-tools',
  }
}

function publicTurnResults(turns: ConversationTurnDetails[]): Array<{ turnId: string; invocationId: string; reply: string }> {
  const results: Array<{ turnId: string; invocationId: string; reply: string }> = []
  for (const details of turns) {
    for (const invocation of details.invocations) {
      if (invocation.status !== 'settled'
        || invocation.kind !== 'response' && invocation.kind !== 'handoff_response'
        || !invocation.resultJson) continue
      const reply = publicReply(invocation.resultJson)
      if (reply) results.push({ turnId: details.turn.id, invocationId: invocation.id, reply })
    }
  }
  return results
}

function publicReply(resultJson: string): string | undefined {
  try {
    const value = JSON.parse(resultJson) as unknown
    if (!isRecord(value)) return undefined
    const parsed = isRecord(value.parsed) ? value.parsed : undefined
    const reply = typeof parsed?.reply === 'string'
      ? parsed.reply
      : typeof value.reply === 'string' ? value.reply : undefined
    return reply?.trim() || undefined
  } catch {
    return undefined
  }
}

function relevantAcceptedMemories(memories: MemoryRecord[], channelId: string): MemoryRecord[] {
  return memories.filter((memory) =>
    memory.status === 'active'
    && (memory.scope === 'global' || memory.scope === 'channel' && memory.channelId === channelId))
}

function memorySubjectKey(content: string): string | undefined {
  const normalized = content.trim().toLocaleLowerCase().replace(/[.!?。！？]+$/u, '').trim()
  const explicitKey = normalized.match(/^([^:=\n]{1,100})\s*[:=]/u)
  if (explicitKey) return `key:${normalizeKeyPart(explicitKey[1])}`

  const english = normalized.match(/^(.+?)\s+(prefers?|uses?|requires?|needs?|wants?|must use|should use|is|are|has|have)\s+.+$/u)
  if (english) return `subject:${normalizeKeyPart(english[1])}|predicate:${normalizePredicate(english[2])}`

  const chinese = normalized.match(/^(.+?)(偏好|喜欢|使用|采用|要求|需要|必须|是|为).+$/u)
  if (chinese) return `subject:${normalizeKeyPart(chinese[1])}|predicate:${chinese[2]}`
  return undefined
}

function normalizeKeyPart(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function normalizePredicate(value: string): string {
  const predicate = value.replace(/\s+/g, ' ').trim()
  const canonical: Record<string, string> = {
    prefers: 'prefer', prefer: 'prefer', uses: 'use', use: 'use', requires: 'require', require: 'require',
    needs: 'need', need: 'need', wants: 'want', want: 'want', is: 'be', are: 'be', has: 'have', have: 'have',
  }
  return canonical[predicate] ?? predicate
}

async function persistArtifacts(
  runDirectory: string,
  artifacts: ReadonlyMap<RuntimeArtifactType, string[]>,
): Promise<void> {
  await Promise.all([...artifacts.entries()].map(([type, chunks]) =>
    writeFile(path.join(runDirectory, `${type}.log`), chunks.join(''), 'utf8')))
}

function cancelOutcome(runtime: RuntimeAdapter, session: RuntimeSession, outcome: RuntimeOutcome): RuntimeOutcome {
  try {
    runtime.cancel(session)
    return outcome
  } catch (error) {
    const cancellation = `Runtime cancellation failed: ${errorMessage(error)}.`
    return {
      kind: 'error',
      error: new Error(outcome.kind === 'error' ? `${outcome.error.message} ${cancellation}` : cancellation),
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
