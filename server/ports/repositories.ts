import type { Agent, AgentStatus, CreateAgentInput } from '../domain/agent'
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
  agents: Agent[]
  repositories: Array<
    Repository & {
      channels: Channel[]
      tasks: Task[]
    }
  >
  recentMessages: Message[]
}

export interface BootstrapSnapshot {
  workspaces: BootstrapWorkspace[]
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
  createAgent(input: CreateAgentInput): Agent
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
  recordTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): void
  afterCommit(event: DomainEvent): void
}

export interface WorkspaceRepositories extends TaskSessionStore {
  inTransaction<T>(work: (unitOfWork: WorkspaceUnitOfWork) => T): T
  createWorkspace(input: CreateWorkspaceInput): Workspace
  createRepository(input: CreateRepositoryInput): Repository
  createChannel(input: CreateChannelInput): Channel
  createAgent(input: CreateAgentInput): Agent
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
  finishTaskExecution(taskId: string, agentId: string, next: Extract<TaskStatus, 'in_review' | 'needs_human'>, reason: string): Task
  getActiveTaskForAgent(agentId: string): Task | undefined
  reclaimReturnedTask(taskId: string, agentId: string, occurredAt: Date): TaskClaim | undefined
  getTask(taskId: string): Task | undefined
  getTasksForRepository(repositoryId: string): Task[]
  getTaskDetails(taskId: string): TaskDetails | undefined
  getTaskArtifact(taskId: string, artifactId: string): TaskArtifact | undefined
  getMessage(messageId: string): Message | undefined
  hasAgentMention(workspaceId: string, mentionName: string): boolean
  getIdleAgentIds(): string[]
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
