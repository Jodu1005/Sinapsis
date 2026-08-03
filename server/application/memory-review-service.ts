import { assertSafeMemoryContent, normalizeMemoryContent } from './memory-consolidation-protocol'
import type { MemoryCandidate, MemoryRecord, MemoryScope } from '../domain/memory'
import { DomainError } from '../domain/task'
import { NotFoundError } from './workspace-service'

export interface AcceptMemoryCandidateRequest {
  scope: MemoryScope
  channelId?: string
  content: string
}

export interface MemoryReviewRepositories {
  getMemoryCandidate(candidateId: string): MemoryCandidate | undefined
  getMemoryByCandidateId(candidateId: string): MemoryRecord | undefined
  getChannel(channelId: string): { id: string } | undefined
  createMemoryFromCandidate(input: {
    candidateId: string
    reviewedContent: string
    reviewedScope: MemoryScope
    reviewedChannelId: string | null
    occurredAt: Date
  }): MemoryRecord
  reviewMemoryCandidate(input: { candidateId: string; status: 'ignored' | 'superseded'; occurredAt: Date }): MemoryCandidate
  updateMemory(memoryId: string, content: string): MemoryRecord
  archiveMemory(memoryId: string, occurredAt: Date): MemoryRecord
  listMemoryCandidates(): MemoryCandidate[]
  listAcceptedMemories(scope: MemoryScope, channelId?: string): MemoryRecord[]
  getBootstrap(): { channels: Array<{ id: string }> }
}

export class MemoryReviewValidationError extends Error {}

export class MemoryReviewService {
  private readonly now: () => Date

  constructor(private readonly options: { repositories: MemoryReviewRepositories; now?: () => Date }) {
    this.now = options.now ?? (() => new Date())
  }

  listCandidates(): MemoryCandidate[] {
    return this.options.repositories.listMemoryCandidates()
  }

  listMemories(): MemoryRecord[] {
    return [
      ...this.options.repositories.listAcceptedMemories('global'),
      ...this.options.repositories.getBootstrap().channels.flatMap((channel) => (
        this.options.repositories.listAcceptedMemories('channel', channel.id)
      )),
    ]
  }

  accept(candidateId: string, request: AcceptMemoryCandidateRequest): MemoryRecord {
    const candidate = this.requireCandidate(candidateId)
    if (candidate.status === 'accepted') return this.acceptedMemory(candidateId)
    this.assertPending(candidate)
    const content = reviewedContent(request.content)
    const reviewedChannelId = reviewedChannel(request, this.options.repositories)

    try {
      return this.options.repositories.createMemoryFromCandidate({
        candidateId, reviewedContent: content, reviewedScope: request.scope, reviewedChannelId, occurredAt: this.now(),
      })
    } catch (error) {
      const after = this.options.repositories.getMemoryCandidate(candidateId)
      if (after?.status === 'accepted') return this.acceptedMemory(candidateId)
      throw error
    }
  }

  ignore(candidateId: string): MemoryCandidate {
    const candidate = this.requireCandidate(candidateId)
    this.assertPending(candidate)
    return this.options.repositories.reviewMemoryCandidate({ candidateId, status: 'ignored', occurredAt: this.now() })
  }

  update(memoryId: string, request: { content: string }): MemoryRecord {
    return this.options.repositories.updateMemory(memoryId, reviewedContent(request.content))
  }

  archive(memoryId: string): MemoryRecord {
    return this.options.repositories.archiveMemory(memoryId, this.now())
  }

  private requireCandidate(candidateId: string): MemoryCandidate {
    const candidate = this.options.repositories.getMemoryCandidate(candidateId)
    if (!candidate) throw new NotFoundError(`Memory candidate ${candidateId} does not exist.`)
    return candidate
  }

  private acceptedMemory(candidateId: string): MemoryRecord {
    const memory = this.options.repositories.getMemoryByCandidateId(candidateId)
    if (!memory) throw new DomainError(`Accepted Memory candidate ${candidateId} has no Memory.`)
    return memory
  }

  private assertPending(candidate: MemoryCandidate): void {
    if (candidate.status !== 'pending') throw new DomainError(`Memory candidate ${candidate.id} is not pending.`)
  }
}

function reviewedContent(value: string): string {
  if (typeof value !== 'string') throw new MemoryReviewValidationError('content must be a string.')
  if (value.length > 10_000) throw new MemoryReviewValidationError('content must not exceed 10,000 characters.')
  let content: string
  try {
    content = normalizeMemoryContent(value)
  } catch (error) {
    throw new MemoryReviewValidationError(error instanceof Error ? error.message : 'Invalid Memory content.')
  }
  try {
    assertSafeMemoryContent(content)
  } catch (error) {
    throw new MemoryReviewValidationError(error instanceof Error ? error.message : 'Unsafe Memory content.')
  }
  return content
}

function reviewedChannel(request: AcceptMemoryCandidateRequest, repositories: MemoryReviewRepositories): string | null {
  if (request.scope === 'global') {
    if (request.channelId !== undefined) throw new MemoryReviewValidationError('channelId must be omitted for global scope.')
    return null
  }
  if (request.scope !== 'channel') throw new MemoryReviewValidationError('scope must be global or channel.')
  if (typeof request.channelId !== 'string' || !request.channelId) {
    throw new MemoryReviewValidationError('channelId is required for channel scope.')
  }
  if (!repositories.getChannel(request.channelId)) throw new MemoryReviewValidationError(`Channel ${request.channelId} does not exist.`)
  return request.channelId
}
