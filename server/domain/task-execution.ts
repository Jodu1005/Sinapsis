export const taskExecutionStatuses = ['starting', 'running', 'finished', 'orphaned'] as const
export type TaskExecutionStatus = (typeof taskExecutionStatuses)[number]

export interface TaskExecution {
  id: string
  taskId: string
  agentId: string
  runtime: 'opencode' | 'pi' | 'claude-code'
  worktreePath: string | null
  runtimeSessionId: string | null
  status: TaskExecutionStatus
  createdAt: string
  startedAt: string | null
  heartbeatAt: string
  endedAt: string | null
  endReason: string | null
}

export interface StartTaskExecutionInput {
  taskId: string
  agentId: string
  runtime: TaskExecution['runtime']
}
