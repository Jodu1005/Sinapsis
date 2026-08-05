import type { StartTaskExecutionInput, TaskExecution } from '../domain/task-execution'

/** Durable ownership of a Runtime process and its task worktree. */
export interface TaskExecutionStore {
  startTaskExecution(input: StartTaskExecutionInput): TaskExecution
  activateTaskExecution(input: {
    executionId: string
    worktreePath: string
    runtimeSessionId: string | null
    occurredAt: Date
  }): TaskExecution
  completeTaskExecutionRecord(executionId: string, reason: string, occurredAt: Date): TaskExecution | undefined
  getTaskExecution(executionId: string): TaskExecution | undefined
  getActiveTaskExecution(taskId: string): TaskExecution | undefined
  orphanActiveTaskExecutions(occurredAt: Date): TaskExecution[]
}
