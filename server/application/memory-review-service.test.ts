import { describe, expect, it } from 'vitest'
import type { MemoryCandidate, MemoryRecord } from '../domain/memory'
import type { Channel } from '../domain/workspace'
import { MemoryReviewService, MemoryReviewValidationError } from './memory-review-service'

describe('MemoryReviewService', () => {
  it('accepts pending Candidates into the human-selected target Channel and is idempotent', () => {
    const sourceChannel = channel('source-channel')
    const targetChannel = channel('target-channel')
    const candidate = memoryCandidate({ channelId: sourceChannel.id })
    const repositories = new FakeMemoryReviewRepositories([sourceChannel, targetChannel], candidate)
    const service = new MemoryReviewService({ repositories, now: () => new Date('2026-08-03T00:00:00.000Z') })

    const accepted = service.accept(candidate.id, {
      scope: 'channel', channelId: targetChannel.id, content: 'Use React for the frontend.',
    })
    const repeated = service.accept(candidate.id, {
      scope: 'channel', channelId: targetChannel.id, content: 'Ignored after the first request.',
    })

    expect(accepted).toMatchObject({ scope: 'channel', channelId: targetChannel.id, sourceCandidateId: candidate.id })
    expect(repeated).toEqual(accepted)
    expect(repositories.createInputs).toEqual([expect.objectContaining({
      candidateId: candidate.id, reviewedScope: 'channel', reviewedChannelId: targetChannel.id,
    })])
    expect(repositories.candidate).toMatchObject({ status: 'accepted', channelId: sourceChannel.id })
  })

  it('only reviews pending Candidates and validates safe, bounded reviewed content', () => {
    const candidate = memoryCandidate({ status: 'ignored' })
    const repositories = new FakeMemoryReviewRepositories([channel('source-channel')], candidate)
    const service = new MemoryReviewService({ repositories })

    expect(() => service.accept(candidate.id, { scope: 'global', content: 'Useful fact.' })).toThrow(/not pending/i)
    expect(() => service.ignore(candidate.id)).toThrow(/not pending/i)
    repositories.candidate = memoryCandidate()
    expect(() => service.accept(repositories.candidate.id, { scope: 'channel', content: 'Useful fact.' }))
      .toThrow(MemoryReviewValidationError)
    expect(() => service.accept(repositories.candidate.id, { scope: 'global', content: 'x'.repeat(10_001) }))
      .toThrow(/10,000/)
    expect(() => service.accept(repositories.candidate.id, { scope: 'global', content: 'API_KEY=super-secret-value' }))
      .toThrow(/unsafe/i)
  })

  it('updates content without changing source and archives without deleting provenance', () => {
    const candidate = memoryCandidate()
    const repositories = new FakeMemoryReviewRepositories([channel('source-channel')], candidate)
    const service = new MemoryReviewService({ repositories, now: () => new Date('2026-08-03T00:00:00.000Z') })
    const memory = service.accept(candidate.id, { scope: 'global', content: 'Use React for the frontend.' })

    const updated = service.update(memory.id, { content: 'Frontend standard is React.' })
    const archived = service.archive(memory.id)

    expect(updated).toMatchObject({ sourceCandidateId: candidate.id, content: 'Frontend standard is React.' })
    expect(updated.contentHash).not.toBe(memory.contentHash)
    expect(archived).toMatchObject({ status: 'archived', archivedAt: '2026-08-03T00:00:00.000Z' })
    expect(repositories.provenance).toEqual([candidate.id])
  })
})

class FakeMemoryReviewRepositories {
  readonly createInputs: Array<Record<string, unknown>> = []
  readonly provenance: string[] = []
  readonly memories = new Map<string, MemoryRecord>()
  candidate: MemoryCandidate

  constructor(private readonly channels: Channel[], candidate: MemoryCandidate) {
    this.candidate = candidate
  }

  getMemoryCandidate(candidateId: string): MemoryCandidate | undefined {
    return this.candidate.id === candidateId ? this.candidate : undefined
  }

  getMemoryByCandidateId(candidateId: string): MemoryRecord | undefined {
    return [...this.memories.values()].find((memory) => memory.sourceCandidateId === candidateId)
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    return this.memories.get(memoryId)
  }

  getChannel(channelId: string): Channel | undefined {
    return this.channels.find((item) => item.id === channelId)
  }

  createMemoryFromCandidate(input: { candidateId: string; reviewedContent: string; reviewedScope: 'global' | 'channel'; reviewedChannelId: string | null; occurredAt: Date }): MemoryRecord {
    this.createInputs.push(input)
    const memory: MemoryRecord = {
      id: 'memory-1', scope: input.reviewedScope, channelId: input.reviewedChannelId, kind: this.candidate.kind,
      content: input.reviewedContent, contentHash: `hash:${input.reviewedContent}`, status: 'active',
      sourceCandidateId: input.candidateId, archivedAt: null, createdAt: input.occurredAt.toISOString(), updatedAt: input.occurredAt.toISOString(),
    }
    this.candidate = { ...this.candidate, status: 'accepted', reviewedContent: input.reviewedContent, reviewedScope: input.reviewedScope, reviewedAt: input.occurredAt.toISOString() }
    this.memories.set(memory.id, memory)
    this.provenance.push(input.candidateId)
    return memory
  }

  reviewMemoryCandidate(input: { candidateId: string; status: 'ignored' | 'superseded'; occurredAt: Date }): MemoryCandidate {
    this.candidate = { ...this.candidate, status: input.status, reviewedAt: input.occurredAt.toISOString() }
    return this.candidate
  }

  updateMemory(memoryId: string, content: string): MemoryRecord {
    const memory = this.memories.get(memoryId)!
    const updated = { ...memory, content, contentHash: `hash:${content}`, updatedAt: '2026-08-03T00:00:00.000Z' }
    this.memories.set(memoryId, updated)
    return updated
  }

  archiveMemory(memoryId: string, occurredAt: Date): MemoryRecord {
    const memory = this.memories.get(memoryId)!
    const archived = { ...memory, status: 'archived' as const, archivedAt: occurredAt.toISOString(), updatedAt: occurredAt.toISOString() }
    this.memories.set(memoryId, archived)
    return archived
  }

  listMemoryCandidates() { return [this.candidate] }
  listAcceptedMemories() { return [...this.memories.values()].filter((memory) => memory.status === 'active') }
  getBootstrap() { return { channels: this.channels } }
}

function channel(id: string): Channel {
  return { id, name: id, systemKey: null, memberAgentIds: [], archivedAt: null, contextResetAt: null, createdAt: '2026-08-03T00:00:00.000Z', boundWorkspaceIds: [] }
}

function memoryCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'candidate-1', dreamRunId: 'run-1', proposedScope: 'channel', channelId: 'source-channel', kind: 'fact',
    proposedContent: 'Use React for the frontend.', rationale: 'Repeated decision.', confidence: 0.9, importance: 0.8,
    contentHash: 'candidate-hash', status: 'pending', reviewedContent: null, reviewedScope: null, reviewedAt: null,
    createdAt: '2026-08-03T00:00:00.000Z', ...overrides,
  }
}
