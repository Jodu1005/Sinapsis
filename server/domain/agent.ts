export const agentStatuses = ['offline', 'idle', 'busy', 'error'] as const
export type AgentStatus = (typeof agentStatuses)[number]

export const sessionStatuses = [
  'preparing',
  'running',
  'input_queued',
  'completed',
  'cancelled',
  'failed',
  'timed_out',
] as const
export type SessionStatus = (typeof sessionStatuses)[number]

export interface Agent {
  id: string
  workspaceId: string
  mentionName: string
  runtime: 'opencode' | 'pi'
  status: AgentStatus
  capabilityTags: string[]
  createdAt: string
  updatedAt: string
}

export interface TaskSession {
  id: string
  taskId: string
  agentId: string
  runtimeSessionId: string | null
  status: SessionStatus
  createdAt: string
  updatedAt: string
}
