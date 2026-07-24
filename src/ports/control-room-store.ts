import type {
  Activity,
  ControlRoomSnapshot,
  ReviewDecision,
  SessionEvent,
  TaskStatus,
} from '../domain/control-room'

export interface TaskEventCommand {
  readonly taskId: string
  readonly status: TaskStatus
  readonly event: SessionEvent
  readonly activity: Activity
}

export interface ControlRoomStore {
  getSnapshot(): ControlRoomSnapshot
  appendTaskEvent(command: TaskEventCommand): void
  recordReviewDecision(decision: ReviewDecision): void
  subscribe(listener: () => void): () => void
}
