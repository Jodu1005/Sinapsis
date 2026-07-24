export interface TaskSessionStore {
  markTimedOut(taskId: string, agentId: string, occurredAt: Date): void
}
