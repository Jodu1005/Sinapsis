import { describe, expect, it, vi } from 'vitest'
import type { MemoryCandidate, MemoryRecord, DreamRun, DreamRunPatch } from '../domain/memory'
import type { Message } from '../domain/message'
import type { Channel } from '../domain/workspace'
import type { MemoryConsolidationInput } from './memory-consolidator'
import { DreamRunService } from './dream-run-service'

describe('DreamRunService', () => {
  it('completes without invoking the consolidator when the incremental snapshot has no messages', async () => {
    const fixture = createFixture()

    const queued = fixture.service.enqueue({ channelId: 'channel-1', trigger: 'manual' })
    const completed = await fixture.service.waitFor(queued.id)

    expect(completed).toMatchObject({ status: 'completed', candidateCount: 0 })
    expect(fixture.consolidator.inputs).toEqual([])
  })

  it('runs channel maintenance through a queue with configurable concurrency one', async () => {
    const first = deferred<MemoryCandidate[]>()
    const fixture = createFixture({ results: [first.promise, Promise.resolve([])] })
    fixture.repositories.sources.set('channel-1', [message('message-1', 'channel-1')])
    fixture.repositories.sources.set('channel-2', [message('message-2', 'channel-2')])

    const run1 = fixture.service.enqueue({ channelId: 'channel-1', trigger: 'manual' })
    const run2 = fixture.service.enqueue({ channelId: 'channel-2', trigger: 'manual' })
    await vi.waitFor(() => expect(fixture.consolidator.inputs).toHaveLength(1))

    expect(fixture.consolidator.inputs[0]?.channel.id).toBe('channel-1')
    expect(fixture.repositories.getDreamRun(run2.id)?.status).toBe('queued')

    first.resolve([])
    await expect(fixture.service.waitFor(run1.id)).resolves.toMatchObject({ status: 'completed' })
    await expect(fixture.service.waitFor(run2.id)).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.consolidator.inputs.map((input) => input.channel.id)).toEqual(['channel-1', 'channel-2'])
  })

  it('marks a failed channel run and continues with the next queued channel', async () => {
    const fixture = createFixture({ results: [Promise.reject(new Error('model unavailable')), Promise.resolve([])] })
    fixture.repositories.sources.set('channel-1', [message('message-1', 'channel-1')])
    fixture.repositories.sources.set('channel-2', [message('message-2', 'channel-2')])

    const run1 = fixture.service.enqueue({ channelId: 'channel-1', trigger: 'scheduled' })
    const run2 = fixture.service.enqueue({ channelId: 'channel-2', trigger: 'scheduled' })

    await expect(fixture.service.waitFor(run1.id)).resolves.toMatchObject({ status: 'failed', error: 'model unavailable' })
    await expect(fixture.service.waitFor(run2.id)).resolves.toMatchObject({ status: 'completed' })
  })

  it('enqueues every active channel and excludes archived channels', () => {
    const fixture = createFixture()
    fixture.repositories.channels.push(channel('channel-archived', 'archived', '2026-08-03T00:00:00.000Z'))

    const runs = fixture.service.enqueueAllActive('scheduled')

    expect(runs.map((run) => run.scopeId)).toEqual(['channel-1', 'channel-2'])
  })

  it('passes active global and channel memories with the persisted message snapshot', async () => {
    const fixture = createFixture()
    const source = message('message-1', 'channel-1')
    fixture.repositories.sources.set('channel-1', [source])
    fixture.repositories.memories = [memory('global', null), memory('channel', 'channel-1')]

    const run = fixture.service.enqueue({ channelId: 'channel-1', trigger: 'manual' })
    await fixture.service.waitFor(run.id)

    expect(fixture.consolidator.inputs[0]).toMatchObject({
      runId: run.id,
      messages: [source],
      acceptedMemories: fixture.repositories.memories,
      turns: [],
    })
  })
})

function createFixture(options: { results?: Array<Promise<MemoryCandidate[]>> } = {}) {
  const repositories = new FakeDreamRepositories()
  const consolidator = new FakeConsolidator(options.results ?? [])
  return {
    repositories,
    consolidator,
    service: new DreamRunService({ repositories, consolidator, concurrency: 1 }),
  }
}

class FakeConsolidator {
  readonly inputs: MemoryConsolidationInput[] = []

  constructor(private readonly results: Array<Promise<MemoryCandidate[]>>) {}

  consolidate(input: MemoryConsolidationInput): Promise<MemoryCandidate[]> {
    this.inputs.push(input)
    return this.results.shift() ?? Promise.resolve([])
  }
}

class FakeDreamRepositories {
  readonly channels = [channel('channel-1', 'alpha'), channel('channel-2', 'beta')]
  readonly runs = new Map<string, DreamRun>()
  readonly sources = new Map<string, Message[]>()
  memories: MemoryRecord[] = []
  private nextRun = 1

  createIncrementalDreamRun(input: { channelId: string; trigger: DreamRun['trigger'] }): DreamRun {
    const id = `run-${this.nextRun++}`
    const messages = this.sources.get(input.channelId) ?? []
    const last = messages.at(-1)
    const run: DreamRun = {
      id, scope: 'channel', scopeId: input.channelId, trigger: input.trigger, status: 'queued',
      fromMessageCreatedAt: null, fromMessageId: null,
      toMessageCreatedAt: last?.createdAt ?? null, toMessageId: last?.id ?? null,
      candidateCount: 0, error: null, createdAt: '2026-08-03T01:00:00.000Z', startedAt: null, completedAt: null,
    }
    this.runs.set(id, run)
    return run
  }

  getDreamRun(runId: string): DreamRun | undefined {
    return this.runs.get(runId)
  }

  updateDreamRun(runId: string, patch: DreamRunPatch): DreamRun {
    const existing = this.runs.get(runId)
    if (!existing) throw new Error(`Missing run ${runId}.`)
    const updated = { ...existing, ...patch }
    this.runs.set(runId, updated)
    return updated
  }

  getChannel(channelId: string): Channel | undefined {
    return this.channels.find((item) => item.id === channelId)
  }

  getBootstrap(): { channels: Channel[] } {
    return { channels: this.channels }
  }

  listDreamSourceMessages(runId: string): Message[] {
    const run = this.runs.get(runId)
    return run ? this.sources.get(run.scopeId) ?? [] : []
  }

  listAcceptedMemories(scope: 'global' | 'channel', channelId?: string): MemoryRecord[] {
    return this.memories.filter((item) => item.scope === scope && (scope === 'global' || item.channelId === channelId))
  }
}

function channel(id: string, name: string, archivedAt: string | null = null): Channel {
  return {
    id, name, systemKey: null, memberAgentIds: [], boundWorkspaceIds: [], archivedAt,
    createdAt: '2026-08-03T00:00:00.000Z',
  }
}

function message(id: string, channelId: string): Message {
  return {
    id, channelId, threadRootMessageId: null, taskId: null, senderType: 'human', senderId: null,
    authorName: 'Jodu', body: `Message ${id}`, createdAt: `2026-08-03T00:00:0${id.endsWith('1') ? '1' : '2'}.000Z`,
    updatedAt: '2026-08-03T00:00:03.000Z', deletedAt: null,
  }
}

function memory(scope: 'global' | 'channel', channelId: string | null): MemoryRecord {
  return {
    id: `memory-${scope}`, scope, channelId, kind: 'fact', content: `${scope} memory`, contentHash: `${scope}-hash`,
    status: 'active', sourceCandidateId: `candidate-${scope}`, archivedAt: null,
    createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
