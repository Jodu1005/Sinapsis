import type { Agent, CreateAgentInput } from '../domain/agent'
import type { DomainEvent } from '../domain/events'
import type { CreateMessageInput, Message } from '../domain/message'
import type { CreateTaskInput, Task, TaskStatus } from '../domain/task'
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

export interface WorkspaceUnitOfWork {
  createWorkspace(input: CreateWorkspaceInput): Workspace
  createRepository(input: CreateRepositoryInput): Repository
  createChannel(input: CreateChannelInput): Channel
  createAgent(input: CreateAgentInput): Agent
  createTask(input: CreateTaskInput): Task
  createMessage(input: CreateMessageInput): Message
  updateMessageBody(messageId: string, body: string): Message
  deleteMessage(messageId: string): void
  transitionTask(taskId: string, next: TaskStatus, reason: string): Task
  afterCommit(event: DomainEvent): void
}

export interface WorkspaceRepositories {
  inTransaction<T>(work: (unitOfWork: WorkspaceUnitOfWork) => T): T
  createWorkspace(input: CreateWorkspaceInput): Workspace
  createRepository(input: CreateRepositoryInput): Repository
  createChannel(input: CreateChannelInput): Channel
  createAgent(input: CreateAgentInput): Agent
  createTask(input: CreateTaskInput): Task
  createMessage(input: CreateMessageInput): Message
  updateMessageBody(messageId: string, body: string): Message
  deleteMessage(messageId: string): void
  transitionTask(taskId: string, next: TaskStatus, reason: string): Task
  getTask(taskId: string): Task | undefined
  getMessage(messageId: string): Message | undefined
  hasAgentMention(workspaceId: string, mentionName: string): boolean
  getBootstrap(): BootstrapSnapshot
}
