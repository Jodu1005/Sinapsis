import type { TaskClaim, WorkspaceRepositories } from '../ports/repositories'

export const defaultLeaseTtlMs = 30_000

export class TaskScheduler {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly leaseTtlMs = defaultLeaseTtlMs,
  ) {}

  claimNext(agentId: string, occurredAt = new Date()): TaskClaim | undefined {
    return this.repositories.claimNextTask(agentId, occurredAt, this.leaseTtlMs)
  }

  renew(taskId: string, agentId: string, occurredAt = new Date()): boolean {
    return this.repositories.renewTaskLease(taskId, agentId, occurredAt, this.leaseTtlMs) !== undefined
  }
}

export class SchedulerLoop {
  private timer: NodeJS.Timeout | undefined
  private ticking = false

  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly repositories: WorkspaceRepositories,
    private readonly intervalMs = 1_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const agentId of this.repositories.getIdleAgentIds()) {
        this.scheduler.claimNext(agentId, this.now())
      }
    } finally {
      this.ticking = false
    }
  }
}
