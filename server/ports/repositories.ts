import type { Agent, AgentStatus, CreateAgentInput } from '../domain/agent'
import type {
  AgentInvocation,
  ConversationHandoff,
  ConversationSession,
  ConversationTurn,
  ConversationTurnPatch,
  CreateAgentInvocationInput,
  CreateConversationHandoffInput,
  CreateConversationTurnInput,
  CreateTurnParticipantInput,
  InvocationPatch,
  ParticipantPatch,
  TurnParticipant,
  UpsertConversationSessionInput,
} from '../domain/conversation'
import type { DomainEvent } from '../domain/events'
import type { CreateMessageInput, Message } from '../domain/message'
import type { CreateTaskInput, Task, TaskArtifact, TaskDetails, TaskInput, TaskLease, TaskSession, TaskStatus } from '../domain/task'
import type { TaskSessionStore } from './task-session-store'
import type {
  Channel,
  CreateChannelInput,
  CreateRepositoryInput,
  CreateWorkspaceInput,
  Repository,
  Workspace,
} from '../domain/workspace'

export interface BootstrapWorkspace extends Workspace {
  repositories: Repository[]
}

export interface BootstrapSnapshot {
  agents: Agent[]
  channels: Channel[]
  workspaces: BootstrapWorkspace[]
  tasks: Task[]
  recentMessages: Message[]
  maxWorkspaceBindingsPerChannel: number
}

export interface TaskClaim {
  task: Task
  lease: TaskLease
}

export interface ExpiredLease {
  lease: TaskLease
  task: Task
}

export interface LeaseRecovery {
  task: Task
  lease: TaskLease
  outcome: 'requeued' | 'needs_human'
}

export interface WorkspaceUnitOfWork {
  createWorkspace(input: CreateWorkspaceInput): Workspace
  createRepository(input: CreateRepositoryInput): Repository
  createChannel(input: CreateChannelInput): Channel
  ensureSystemChannel(input: CreateChannelInput & { systemKey: string }): Channel
  archiveChannel(channelId: string, occurredAt: Date): Channel
  restoreChannel(channelId: string, occurredAt: Date): Channel
  resetChannelContext(channelId: string, occurredAt: Date): Channel
  createAgent(input: CreateAgentInput): Agent
  updateAgentResponsibilities(agentId: string, responsibilities: string[]): Agent
  createTask(input: CreateTaskInput): Task
  createTaskInput(taskId: string, body: string): TaskInput
  createMessage(input: CreateMessageInput): Message
  createConversationTurn(input: CreateConversationTurnInput): ConversationTurn
  createTurnParticipant(input: CreateTurnParticipantInput): TurnParticipant
  createAgentInvocation(input: CreateAgentInvocationInput): AgentInvocation
  updateMessageBody(messageId: string, body: string): Message
  deleteMessage(messageId: string): void
  transitionTask(taskId: string, next: TaskStatus, reason: string): Task
  allocateTaskWorktree(taskId: string, branchName: string, worktreePath: string): Task
  createTaskSession(taskId: string, agentId: string): TaskSession
  updateTaskSession(taskId: string, agentId: string, input: { runtimeSessionId?: string | null; status?: string }): TaskSession
  consumeTaskInput(inputId: string): TaskInput
  createTaskArtifact(taskId: string, kind: string, path: string): TaskArtifact
  createReviewDecision(taskId: string, decision: string, reason: string): void
  recordTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): void
  afterCommit(event: DomainEvent): void
}

export interface WorkspaceRepositories extends TaskSessionStore {
  inTransaction<T>(work: (unitOfWork: WorkspaceUnitOfWork) => T): T
  createWorkspace(input: CreateWorkspaceInput): Workspace
  createRepository(input: CreateRepositoryInput): Repository
  createChannel(input: CreateChannelInput): Channel
  archiveChannel(channelId: string, occurredAt: Date): Channel
  restoreChannel(channelId: string, occurredAt: Date): Channel
  resetChannelContext(channelId: string, occurredAt: Date): Channel
  createAgent(input: CreateAgentInput): Agent
  updateAgentResponsibilities(agentId: string, responsibilities: string[]): Agent
  createTask(input: CreateTaskInput): Task
  createTaskInput(taskId: string, body: string): TaskInput
  createMessage(input: CreateMessageInput): Message
  updateMessageBody(messageId: string, body: string): Message
  deleteMessage(messageId: string): void
  transitionTask(taskId: string, next: TaskStatus, reason: string): Task
  allocateTaskWorktree(taskId: string, branchName: string, worktreePath: string): Task
  createTaskSession(taskId: string, agentId: string): TaskSession
  updateTaskSession(taskId: string, agentId: string, input: { runtimeSessionId?: string | null; status?: string }): TaskSession
  consumeTaskInput(inputId: string): TaskInput
  createTaskArtifact(taskId: string, kind: string, path: string): TaskArtifact
  createReviewDecision(taskId: string, decision: string, reason: string): void
  finishTaskExecution(taskId: string, agentId: string, next: Extract<TaskStatus, 'in_review' | 'needs_human' | 'cancelled'>, reason: string): Task
  getActiveTaskForAgent(agentId: string): Task | undefined
  reclaimReturnedTask(taskId: string, agentId: string, occurredAt: Date): TaskClaim | undefined
  getTask(taskId: string): Task | undefined
  getAgent(agentId: string): Agent | undefined
  getRepository(repositoryId: string): Repository | undefined
  getTasksForRepository(repositoryId: string): Task[]
  getTasksForChannel(channelId: string): Task[]
  getTaskDetails(taskId: string): TaskDetails | undefined
  getTaskArtifact(taskId: string, artifactId: string): TaskArtifact | undefined
  getMessage(messageId: string): Message | undefined
  createConversationTurn(input: CreateConversationTurnInput): ConversationTurn
  getConversationTurn(turnId: string): ConversationTurn | undefined
  updateConversationTurn(turnId: string, patch: ConversationTurnPatch): ConversationTurn
  createTurnParticipant(input: CreateTurnParticipantInput): TurnParticipant
  updateTurnParticipant(turnId: string, agentId: string, patch: ParticipantPatch): TurnParticipant
  listTurnParticipants(turnId: string): TurnParticipant[]
  createAgentInvocation(input: CreateAgentInvocationInput): AgentInvocation
  updateAgentInvocation(invocationId: string, patch: InvocationPatch): AgentInvocation
  listAgentInvocations(turnId: string): AgentInvocation[]
  createConversationHandoff(input: CreateConversationHandoffInput): ConversationHandoff
  listConversationHandoffs(turnId: string): ConversationHandoff[]
  getConversationSession(key: string): ConversationSession | undefined
  upsertConversationSession(input: UpsertConversationSessionInput): ConversationSession
  listMessagesForConversation(channelId: string, threadRootMessageId: string | null): Message[]
  getLastAgentSpokenAt(channelId: string, agentId: string): string | null
  getChannel(channelId: string): Channel | undefined
  listAgents(): Agent[]
  getChannelAgentIds(channelId: string): string[]
  addChannelAgent(channelId: string, agentId: string, occurredAt: Date): void
  removeChannelAgent(channelId: string, agentId: string): void
  getChannelWorkspaceIds(channelId: string): string[]
  bindChannelWorkspace(channelId: string, workspaceId: string, occurredAt: Date): void
  unbindChannelWorkspace(channelId: string, workspaceId: string): void
  hasUnfinishedTask(channelId: string, workspaceId: string, agentId?: string): boolean
  hasAgentMention(mentionName: string): boolean
  getIdleAgentIds(): string[]
  recoverOrphanedAgents(occurredAt: Date): number
  setAgentStatus(agentId: string, status: AgentStatus, occurredAt: Date): Agent
  claimNextTask(agentId: string, occurredAt: Date): TaskClaim | undefined
  renewTaskLease(taskId: string, agentId: string, occurredAt: Date): TaskLease | undefined
  getActiveLeases(): TaskLease[]
  findExpiredLeases(occurredAt: Date): ExpiredLease[]
  takeExpiredLease(leaseId: string, occurredAt: Date): ExpiredLease | undefined
  finalizeExpiredLease(expiredLease: ExpiredLease, occurredAt: Date): LeaseRecovery | undefined
  failExpiredLeaseAfterSessionTimeoutPersistenceFailure(expiredLease: ExpiredLease, occurredAt: Date): boolean
  getBootstrap(): BootstrapSnapshot
}
