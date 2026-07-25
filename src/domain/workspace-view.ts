export type AgentStatus = 'offline' | 'idle' | 'busy' | 'error'
export type TaskStatus = 'queued' | 'claimed' | 'running' | 'waiting_input' | 'in_review' | 'accepted' | 'returned' | 'needs_human' | 'merged' | 'cancelled'

export interface WorkspaceSnapshot { workspaces: WorkspaceView[] }

export interface WorkspaceView {
  id: string
  name: string
  leaseTtlMs: number
  createdAt: string
  agents: AgentView[]
  repositories: RepositoryView[]
  recentMessages: ChannelMessage[]
}

export interface RepositoryView {
  id: string
  workspaceId: string
  name: string
  path: string
  currentBranch: string
  defaultBranch: string
  isClean: boolean
  createdAt: string
  channels: ChannelView[]
  tasks: TaskView[]
}

export interface ChannelView { id: string; repositoryId: string; name: string; createdAt: string }

export interface AgentView {
  id: string
  workspaceId: string
  identity: string
  mentionName: string
  runtime: 'opencode' | 'pi' | 'claude-code'
  status: AgentStatus
  capabilityTags: string[]
  maxConcurrentTasks: 1
  command: string
  args: string[]
  model: string
  env: string[]
  createdAt: string
  updatedAt: string
}

export interface TaskView {
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
  leaseTtlMs: number | null
  branchName: string | null
  worktreePath: string | null
  createdAt: string
  updatedAt: string
}

export interface ChannelMessage {
  id: string
  channelId: string
  taskId: string | null
  senderType: 'human' | 'agent' | 'system'
  senderId: string | null
  authorName: string
  body: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface TaskDetailView {
  task: TaskView
  sessions: TaskSessionView[]
  leases: TaskLeaseView[]
  inputs: TaskInputView[]
  decisions: ReviewDecisionView[]
  artifacts: TaskArtifactView[]
  events: TaskEventView[]
}

export interface TaskSessionView { id: string; taskId: string; agentId: string; runtimeSessionId: string | null; status: string; createdAt: string; updatedAt: string }
export interface TaskLeaseView { id: string; taskId: string; agentId: string; expiresAt: string; createdAt: string }
export interface TaskInputView { id: string; taskId: string; body: string; createdAt: string; consumedAt: string | null }
export interface ReviewDecisionView { id: string; taskId: string; decision: string; reason: string; createdAt: string }
export interface TaskArtifactView { id: string; taskId: string; kind: string; createdAt: string }
export interface TaskEventView { id: string; taskId: string; type: string; payload: Record<string, unknown>; createdAt: string }

export function channelMessages(workspace: WorkspaceView, channelId: string): ChannelMessage[] {
  return workspace.recentMessages.filter((message) => message.channelId === channelId)
}

export function taskStatusLabel(status: TaskStatus): string {
  return {
    queued: '排队中', claimed: '已领取', running: '执行中', waiting_input: '等待输入', in_review: '等待验收',
    accepted: '已验收', returned: '已退回', needs_human: '需要人工处理', merged: '已合并', cancelled: '已取消',
  }[status]
}

export function agentStatusLabel(status: AgentStatus): string {
  return { offline: '离线', idle: '空闲', busy: '忙碌', error: '异常' }[status]
}
