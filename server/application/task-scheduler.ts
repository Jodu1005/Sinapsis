import type { TaskClaim, WorkspaceRepositories } from '../ports/repositories'

export const defaultLeaseTtlMs = 30_000

export interface TaskClaimStarter {
  startClaim(claim: TaskClaim): Promise<void>
}

export interface ActiveLeaseOwner {
  hasExecution(taskId: string, agentId: string): boolean
}

export class TaskScheduler {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly claimStarter?: TaskClaimStarter,
  ) {}

  claimNext(agentId: string, occurredAt = new Date()): TaskClaim | undefined {
    const claim = this.repositories.claimNextTask(agentId, occurredAt)
    if (claim && this.claimStarter) {
      void this.claimStarter.startClaim(claim).catch(() => undefined)
    }
    return claim
  }

  renew(taskId: string, agentId: string, occurredAt = new Date()): boolean {
    return this.repositories.renewTaskLease(taskId, agentId, occurredAt) !== undefined
  }
}

export class SchedulerLoop {
  private timer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private ticking = false

  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly repositories: WorkspaceRepositories,
    private readonly intervalMs = 1_000,
    private readonly now: () => Date = () => new Date(),
    private readonly activeLeaseOwner?: ActiveLeaseOwner,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), 10_000)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.timer = undefined
    this.heartbeatTimer = undefined
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

  heartbeatTick(): void {
    const occurredAt = this.now()
    for (const lease of this.repositories.getActiveLeases()) {
      if (this.activeLeaseOwner && !this.activeLeaseOwner.hasExecution(lease.taskId, lease.agentId)) continue
      this.scheduler.renew(lease.taskId, lease.agentId, occurredAt)
    }
  }
}
