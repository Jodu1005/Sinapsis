export type AgentStatus = 'offline' | 'idle' | 'busy' | 'error'
export type TaskStatus = 'queued' | 'claimed' | 'running' | 'waiting_input' | 'in_review' | 'accepted' | 'returned' | 'needs_human' | 'merged' | 'cancelled'

export interface WorkspaceSnapshot {
  agents: AgentView[]
  channels: ChannelView[]
  workspaces: WorkspaceView[]
  tasks: TaskView[]
  recentMessages: ChannelMessage[]
  maxWorkspaceBindingsPerChannel: number
  typingAgentIdsByChannel?: Record<string, string[]>
  activeTurnsByChannel?: Record<string, TurnActivityView[]>
}

export interface WorkspaceView {
  id: string
  name: string
  leaseTtlMs: number
  createdAt: string
  repositories: RepositoryView[]
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
}

export interface ChannelView {
  id: string
  name: string
  systemKey: string | null
  memberAgentIds: string[]
  boundWorkspaceIds: string[]
  archivedAt?: string | null
  contextResetAt?: string | null
  createdAt: string
}

export interface AgentView {
  id: string
  identity: string
  mentionName: string
  runtime: 'opencode' | 'pi' | 'claude-code'
  status: AgentStatus
  capabilityTags: string[]
  responsibilities?: string[]
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
  workspaceId: string
  repositoryId: string
  channelId: string
  threadRootMessageId?: string | null
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
  threadRootMessageId?: string | null
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

export interface TurnActivityView {
  turnId: string
  agentId: string | null
  phase: 'screening' | 'judging' | 'queued' | 'preparing' | 'handoff'
  queuePosition: number | null
}

export interface ConversationTurnDetailView {
  turn: ConversationTurnView
  participants: TurnParticipantView[]
  invocations: AgentInvocationView[]
  handoffs: ConversationHandoffView[]
}

export interface ConversationTurnView {
  id: string
  channelId: string
  triggerMessageId: string
  threadRootMessageId: string | null
  mode: 'ordinary' | 'direct' | 'multi_direct' | 'all'
  status: 'screening' | 'judging' | 'responding' | 'handoff' | 'completed' | 'partial' | 'cancelled' | 'failed' | 'interrupted'
  currentRound: number
  maxRounds: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TurnParticipantView {
  id: string
  turnId: string
  agentId: string
  source: 'responsibility' | 'direct' | 'all' | 'handoff'
  rank: number
  matcherScore: number | null
  decision: 'pending' | 'speak' | 'silent' | 'skipped'
  confidence: number | null
  proposedAngle: string | null
  dependsOnAgentId: string | null
  speakingOrder: number | null
  status: 'candidate' | 'selected' | 'spoken' | 'failed' | 'skipped' | 'cancelled'
  reason: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentInvocationView {
  id: string
  turnId: string
  agentId: string
  kind: 'participation' | 'response' | 'duplicate_check' | 'handoff_response'
  priority: 'human_direct' | 'human_ordinary' | 'participation' | 'duplicate_check' | 'automatic_handoff'
  round: number
  status: 'queued' | 'running' | 'settled' | 'failed' | 'cancelled'
  sourceInvocationId: string | null
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  errorCategory: 'timeout' | 'cancelled' | 'runtime_failure' | null
}

export interface ConversationHandoffView {
  id: string
  turnId: string
  sourceInvocationId: string
  fromAgentId: string
  requestedTargetAgentId: string
  toAgentId: string | null
  question: string
  round: number
  status: 'queued' | 'accepted' | 'rejected' | 'completed' | 'failed'
  reason: string | null
  createdAt: string
  updatedAt: string
}

export function snapshotChannelMessages(snapshot: WorkspaceSnapshot, channelId: string): ChannelMessage[] {
  return snapshot.recentMessages.filter((message) => message.channelId === channelId)
}

export function snapshotAgents(snapshot: WorkspaceSnapshot): AgentView[] {
  return snapshot.agents
}

export function distinctAgentsByIdentity(agents: AgentView[]): AgentView[] {
  const names = new Set<string>()
  return [...agents]
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id))
    .filter((agent) => {
      const key = agent.identity.toLocaleLowerCase()
      if (names.has(key)) return false
      names.add(key)
      return true
    })
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
