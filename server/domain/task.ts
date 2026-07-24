export const taskStatuses = [
  'queued',
  'claimed',
  'running',
  'waiting_input',
  'in_review',
  'accepted',
  'returned',
  'needs_human',
  'merged',
  'cancelled',
] as const
export type TaskStatus = (typeof taskStatuses)[number]

export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

export interface Task {
  id: string
  repositoryId: string
  channelId: string
  directAgentId: string | null
  title: string
  description: string
  acceptanceCriteria: string
  labels: string[]
  status: TaskStatus
  queuedAt: string
  attemptCount: number
  maxRetries: number
  timeoutMs: number
  branchName: string | null
  worktreePath: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  repositoryId: string
  channelId: string
  directAgentId?: string | null
  title: string
  description: string
  acceptanceCriteria: string
  labels?: string[]
  maxRetries?: number
  timeoutMs?: number
}

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'queued', 'needs_human', 'cancelled'],
  running: ['waiting_input', 'in_review', 'returned', 'needs_human', 'cancelled'],
  waiting_input: ['running', 'needs_human', 'cancelled'],
  in_review: ['accepted', 'returned', 'needs_human', 'cancelled'],
  accepted: ['merged'],
  returned: ['queued', 'claimed', 'needs_human', 'cancelled'],
  needs_human: ['queued', 'cancelled'],
  merged: [],
  cancelled: [],
}

export function transitionTask(task: Task, next: TaskStatus, reason: string, occurredAt = new Date().toISOString()): Task {
  if (!reason.trim()) {
    throw new DomainError('Task transitions require a reason.')
  }

  if (!allowedTransitions[task.status].includes(next)) {
    throw new DomainError(`Cannot transition task from ${task.status} to ${next}.`)
  }

  return {
    ...task,
    status: next,
    queuedAt: next === 'queued' ? occurredAt : task.queuedAt,
    updatedAt: occurredAt,
  }
}
