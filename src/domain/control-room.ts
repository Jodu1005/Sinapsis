export type TaskStatus = 'todo' | 'running' | 'needs_input' | 'in_review' | 'accepted' | 'rejected'
export type EventKind = 'agent' | 'checkpoint' | 'feedback' | 'decision' | 'artifact'
export type ReviewOutcome = 'accepted' | 'rejected'

export interface AgentSeat {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly runtime: string
  readonly state: 'active' | 'waiting' | 'reviewing'
}

export interface SessionEvent {
  readonly id: string
  readonly kind: EventKind
  readonly message: string
  readonly at: string
}

export interface Task {
  readonly id: string
  readonly title: string
  readonly ownerId: string
  readonly status: TaskStatus
  readonly summary: string
  readonly updatedAt: string
  readonly events: readonly SessionEvent[]
  readonly changedFiles: readonly string[]
  readonly diffSummary?: string
  readonly testOutput?: string
}

export interface Activity {
  readonly id: string
  readonly taskId: string
  readonly message: string
  readonly at: string
}

export interface ReviewDecision {
  readonly id: string
  readonly taskId: string
  readonly outcome: ReviewOutcome
  readonly message: string
  readonly at: string
}

export interface ControlRoomSnapshot {
  readonly projectName: string
  readonly branch: string
  readonly agents: readonly AgentSeat[]
  readonly tasks: readonly Task[]
  readonly activities: readonly Activity[]
}
