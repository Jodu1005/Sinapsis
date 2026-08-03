import type { DreamRun, DreamRunPatch, MemoryCandidate, MemoryRecord } from '../domain/memory'
import type { Message } from '../domain/message'
import type { Channel } from '../domain/workspace'
import type { MemoryConsolidationInput } from './memory-consolidator'

export interface DreamRunRepositories {
  createIncrementalDreamRun(input: { channelId: string; trigger: DreamRun['trigger'] }): DreamRun
  getDreamRun(runId: string): DreamRun | undefined
  updateDreamRun(runId: string, patch: DreamRunPatch): DreamRun
  getChannel(channelId: string): Channel | undefined
  getBootstrap(): { channels: Channel[] }
  listDreamSourceMessages(runId: string): Message[]
  listAcceptedMemories(scope: 'global' | 'channel', channelId?: string): MemoryRecord[]
}

export interface DreamMemoryConsolidator {
  consolidate(input: MemoryConsolidationInput): Promise<MemoryCandidate[]>
}

export interface DreamRunServiceOptions {
  repositories: DreamRunRepositories
  consolidator: DreamMemoryConsolidator
  concurrency: number
  now?: () => Date
}

export class DreamRunService {
  private readonly repositories: DreamRunRepositories
  private readonly consolidator: DreamMemoryConsolidator
  private readonly concurrency: number
  private readonly now: () => Date
  private readonly pendingRunIds: string[] = []
  private readonly scheduledRunIds = new Set<string>()
  private readonly waiters = new Map<string, Array<(run: DreamRun) => void>>()
  private active = 0
  private drainScheduled = false
  private shuttingDown = false
  private readonly idleWaiters: Array<() => void> = []

  constructor(options: DreamRunServiceOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('Dream maintenance concurrency must be a positive integer.')
    }
    this.repositories = options.repositories
    this.consolidator = options.consolidator
    this.concurrency = options.concurrency
    this.now = options.now ?? (() => new Date())
  }

  enqueue(input: { channelId: string; trigger: DreamRun['trigger'] }): DreamRun {
    if (this.shuttingDown) throw new Error('Dream maintenance service is shutting down.')
    const channel = this.repositories.getChannel(input.channelId)
    if (!channel) throw new Error(`Channel ${input.channelId} does not exist.`)
    if (channel.archivedAt) throw new Error(`Channel #${channel.name} is archived.`)

    let run = this.repositories.createIncrementalDreamRun(input)
    if (run.status === 'failed' || run.status === 'cancelled') {
      run = this.repositories.updateDreamRun(run.id, {
        status: 'queued', error: null, startedAt: null, completedAt: null,
      })
    }
    if (run.status === 'queued') this.schedule(run.id)
    return run
  }

  enqueueAllActive(trigger: DreamRun['trigger']): DreamRun[] {
    return this.repositories.getBootstrap().channels
      .filter((channel) => !channel.archivedAt)
      .map((channel) => this.enqueue({ channelId: channel.id, trigger }))
  }

  waitFor(runId: string): Promise<DreamRun> {
    const run = this.repositories.getDreamRun(runId)
    if (!run) return Promise.reject(new Error(`Dream run ${runId} does not exist.`))
    if (isTerminal(run)) return Promise.resolve(run)
    return new Promise<DreamRun>((resolve) => {
      const waiters = this.waiters.get(runId) ?? []
      waiters.push(resolve)
      this.waiters.set(runId, waiters)
    })
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve) })
  }

  private schedule(runId: string): void {
    if (this.scheduledRunIds.has(runId)) return
    this.scheduledRunIds.add(runId)
    this.pendingRunIds.push(runId)
    if (this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const runId = this.pendingRunIds.shift()
      if (!runId) break
      this.active += 1
      void this.execute(runId).finally(() => {
        this.active -= 1
        this.scheduledRunIds.delete(runId)
        this.drain()
      })
    }
    this.resolveIdleWaiters()
  }

  private async execute(runId: string): Promise<void> {
    const queued = this.repositories.getDreamRun(runId)
    if (!queued || queued.status !== 'queued') return
    const startedAt = this.now().toISOString()
    this.repositories.updateDreamRun(runId, { status: 'running', startedAt, error: null })

    try {
      const channel = this.repositories.getChannel(queued.scopeId)
      if (!channel || channel.archivedAt) throw new Error(`Dream channel ${queued.scopeId} is unavailable.`)
      const messages = this.repositories.listDreamSourceMessages(runId)
      const candidates = messages.length === 0
        ? []
        : await this.consolidator.consolidate({
            runId,
            channel,
            messages,
            turns: [],
            acceptedMemories: [
              ...this.repositories.listAcceptedMemories('global'),
              ...this.repositories.listAcceptedMemories('channel', channel.id),
            ],
          })
      const completed = this.repositories.updateDreamRun(runId, {
        status: 'completed', candidateCount: candidates.length, completedAt: this.now().toISOString(), error: null,
      })
      this.resolveWaiters(completed)
    } catch (error) {
      const failed = this.repositories.updateDreamRun(runId, {
        status: 'failed', error: errorMessage(error), completedAt: this.now().toISOString(),
      })
      this.resolveWaiters(failed)
    }
  }

  private resolveWaiters(run: DreamRun): void {
    const waiters = this.waiters.get(run.id) ?? []
    this.waiters.delete(run.id)
    for (const resolve of waiters) resolve(run)
  }

  private isIdle(): boolean {
    return this.active === 0 && this.pendingRunIds.length === 0 && !this.drainScheduled
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}

function isTerminal(run: DreamRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
