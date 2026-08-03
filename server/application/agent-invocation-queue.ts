import type { InvocationPriority } from '../domain/conversation'

export interface QueuedInvocation<T> {
  id: string
  agentId: string
  priority: InvocationPriority
  sequence: number
  run(): Promise<T>
}

interface QueueEntry {
  invocation: QueuedInvocation<unknown>
  insertionOrder: number
  resolve(value: unknown): void
  reject(reason: unknown): void
}

interface AgentLane {
  running: QueueEntry | null
  queued: QueueEntry[]
}

export type AgentInvocationCancellationState = 'queued' | 'running' | 'not_found'

export interface AgentInvocationCancellationResult {
  invocationId: string
  state: AgentInvocationCancellationState
}

export interface AgentInvocationSnapshot {
  state: AgentInvocationCancellationState
  position: number | null
}

export class AgentInvocationQueueCancelledError extends Error {
  constructor(readonly invocationId: string) {
    super(`Invocation ${invocationId} was cancelled.`)
    this.name = 'AgentInvocationQueueCancelledError'
  }
}

const priorityRank: Record<InvocationPriority, number> = {
  human_direct: 0,
  human_ordinary: 1,
  participation: 2,
  duplicate_check: 3,
  automatic_handoff: 4,
}

export class AgentInvocationQueue {
  private readonly lanes = new Map<string, AgentLane>()
  private insertionSequence = 0

  enqueue<T>(invocation: QueuedInvocation<T>): Promise<T> {
    const lane = this.lanes.get(invocation.agentId) ?? { running: null, queued: [] }
    this.lanes.set(invocation.agentId, lane)

    const result = new Promise<T>((resolve, reject) => {
      lane.queued.push({
        invocation: invocation as QueuedInvocation<unknown>,
        insertionOrder: this.insertionSequence++,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    this.drain(invocation.agentId, lane)
    return result
  }

  cancel(predicate: (invocation: QueuedInvocation<unknown>) => boolean): void {
    for (const [agentId, lane] of this.lanes) {
      const retained: QueueEntry[] = []
      for (const entry of lane.queued) {
        if (predicate(entry.invocation)) {
          entry.reject(new AgentInvocationQueueCancelledError(entry.invocation.id))
        } else {
          retained.push(entry)
        }
      }
      lane.queued = retained
      if (!lane.running && lane.queued.length === 0) this.lanes.delete(agentId)
    }
  }

  cancelInvocation(invocationId: string): AgentInvocationCancellationResult {
    for (const [agentId, lane] of this.lanes) {
      if (lane.running?.invocation.id === invocationId) {
        return { invocationId, state: 'running' }
      }
      const index = lane.queued.findIndex((entry) => entry.invocation.id === invocationId)
      if (index < 0) continue
      const [entry] = lane.queued.splice(index, 1)
      entry!.reject(new AgentInvocationQueueCancelledError(invocationId))
      if (!lane.running && lane.queued.length === 0) this.lanes.delete(agentId)
      return { invocationId, state: 'queued' }
    }
    return { invocationId, state: 'not_found' }
  }

  snapshot(agentId: string): { running: boolean; queued: number } {
    const lane = this.lanes.get(agentId)
    return { running: lane?.running !== null && lane?.running !== undefined, queued: lane?.queued.length ?? 0 }
  }

  snapshotInvocation(invocationId: string): AgentInvocationSnapshot {
    for (const lane of this.lanes.values()) {
      if (lane.running?.invocation.id === invocationId) return { state: 'running', position: 1 }
      const queued = [...lane.queued].sort(compareEntries)
      const index = queued.findIndex((entry) => entry.invocation.id === invocationId)
      if (index >= 0) {
        return {
          state: 'queued',
          position: index + (lane.running ? 2 : 1),
        }
      }
    }
    return { state: 'not_found', position: null }
  }

  private drain(agentId: string, lane: AgentLane): void {
    if (lane.running) return
    lane.queued.sort(compareEntries)
    const next = lane.queued.shift()
    if (!next) {
      this.lanes.delete(agentId)
      return
    }

    lane.running = next
    void Promise.resolve()
      .then(() => next.invocation.run())
      .then(next.resolve, next.reject)
      .finally(() => {
        lane.running = null
        this.drain(agentId, lane)
      })
  }
}

function compareEntries(left: QueueEntry, right: QueueEntry): number {
  return priorityRank[left.invocation.priority] - priorityRank[right.invocation.priority]
    || left.invocation.sequence - right.invocation.sequence
    || left.insertionOrder - right.insertionOrder
}
