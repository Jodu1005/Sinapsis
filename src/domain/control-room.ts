export type TaskStatus = 'todo' | 'running' | 'needs_input' | 'in_review' | 'accepted' | 'rejected'
export type EventKind = 'agent' | 'checkpoint' | 'feedback' | 'decision' | 'artifact'

export interface AgentSeat {
  id: string
  name: string
  role: string
  runtime: string
  state: 'active' | 'waiting' | 'reviewing'
}

export interface SessionEvent {
  id: string
  kind: EventKind
  message: string
  at: string
}

export interface Task {
  id: string
  title: string
  ownerId: string
  status: TaskStatus
  summary: string
  updatedAt: string
  events: SessionEvent[]
  changedFiles: string[]
  diffSummary?: string
  testOutput?: string
}

export interface Activity {
  id: string
  taskId: string
  message: string
  at: string
}

export interface ControlRoomSnapshot {
  projectName: string
  branch: string
  agents: AgentSeat[]
  tasks: Task[]
  activities: Activity[]
}
