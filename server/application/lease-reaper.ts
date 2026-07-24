import type { WorkspaceRepositories } from '../ports/repositories'
import type { ProcessTerminator } from '../ports/process-terminator'
import type { TaskSessionStore } from '../ports/task-session-store'

export class LeaseReaper {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly processTerminator: ProcessTerminator,
    private readonly sessionStore: TaskSessionStore,
  ) {}

  async reap(occurredAt = new Date()): Promise<number> {
    const expired = this.repositories.findExpiredLeases(occurredAt)
    let recovered = 0
    for (const { lease } of expired) {
      const ownedLease = this.repositories.takeExpiredLease(lease.id, occurredAt)
      if (!ownedLease) continue
      try {
        await this.processTerminator.terminate(ownedLease.lease.taskId, ownedLease.lease.agentId)
      } catch {
        // The lease must still be recovered when a stale process is already gone.
      }
      this.sessionStore.markTimedOut(ownedLease.lease.taskId, ownedLease.lease.agentId, occurredAt)
      if (this.repositories.finalizeExpiredLease(ownedLease, occurredAt)) recovered += 1
    }
    return recovered
  }
}

export class LeaseReaperLoop {
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> | undefined

  constructor(
    private readonly reaper: Pick<LeaseReaper, 'reap'>,
    private readonly intervalMs = 5_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.triggerReap(), this.intervalMs)
    void this.triggerReap()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  private triggerReap(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const reaping = this.reaper.reap(this.now()).then(() => undefined)
    let tracked: Promise<void>
    tracked = reaping.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined
    })
    this.inFlight = tracked
    return tracked
  }
}
