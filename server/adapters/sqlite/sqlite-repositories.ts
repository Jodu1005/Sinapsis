import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Agent } from '../../domain/agent'
import type { DomainEvent } from '../../domain/events'
import type { CreateMessageInput, Message, MessageSenderType } from '../../domain/message'
import { type CreateTaskInput, type Task, type TaskStatus, transitionTask as transitionTaskDomain } from '../../domain/task'
import type {
  Channel,
  CreateChannelInput,
  CreateRepositoryInput,
  CreateWorkspaceInput,
  Repository,
  Workspace,
} from '../../domain/workspace'
import type { DomainEventPublisher } from '../../ports/domain-event-publisher'
import type { BootstrapSnapshot, WorkspaceRepositories, WorkspaceUnitOfWork } from '../../ports/repositories'
import type { SqliteDatabase } from './database'

interface WorkspaceRow {
  id: string
  name: string
  created_at: string
}

interface RepositoryRow {
  id: string
  workspace_id: string
  name: string
  path: string
  created_at: string
}

interface ChannelRow {
  id: string
  repository_id: string
  name: string
  created_at: string
}

interface TaskRow {
  id: string
  repository_id: string
  channel_id: string
  direct_agent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  labels_json: string
  status: TaskStatus
  queued_at: string
  attempt_count: number
  max_retries: number
  timeout_ms: number
  branch_name: string | null
  worktree_path: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  channel_id: string
  task_id: string | null
  sender_type: MessageSenderType
  sender_id: string | null
  author_name: string
  body: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface AgentRow {
  id: string
  workspace_id: string
  mention_name: string
  runtime: 'opencode' | 'pi'
  status: Agent['status']
  capability_tags_json: string
  created_at: string
  updated_at: string
}

export class SqliteUnitOfWork implements WorkspaceUnitOfWork {
  private readonly events: DomainEvent[] = []

  constructor(
    private readonly database: DatabaseSync,
    private readonly publisher: DomainEventPublisher,
  ) {}

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const createdAt = now()
    const workspace: Workspace = { id: randomUUID(), name: requireText(input.name, 'Workspace name'), createdAt }
    this.database.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(workspace.id, workspace.name, workspace.createdAt)
    return workspace
  }

  createRepository(input: CreateRepositoryInput): Repository {
    const createdAt = now()
    const repository: Repository = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: requireText(input.name, 'Repository name'),
      path: requireText(input.path, 'Repository path'),
      createdAt,
    }
    this.database.prepare('INSERT INTO repositories (id, workspace_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      repository.id,
      repository.workspaceId,
      repository.name,
      repository.path,
      repository.createdAt,
    )
    return repository
  }

  createChannel(input: CreateChannelInput): Channel {
    const createdAt = now()
    const channel: Channel = {
      id: randomUUID(),
      repositoryId: input.repositoryId,
      name: requireText(input.name, 'Channel name'),
      createdAt,
    }
    this.database.prepare('INSERT INTO channels (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      channel.id,
      channel.repositoryId,
      channel.name,
      channel.createdAt,
    )
    return channel
  }

  createTask(input: CreateTaskInput): Task {
    const createdAt = now()
    const task: Task = {
      id: randomUUID(),
      repositoryId: input.repositoryId,
      channelId: input.channelId,
      directAgentId: input.directAgentId ?? null,
      title: requireText(input.title, 'Task title'),
      description: requireText(input.description, 'Task description'),
      acceptanceCriteria: requireText(input.acceptanceCriteria, 'Acceptance criteria'),
      labels: input.labels ?? [],
      status: 'queued',
      queuedAt: createdAt,
      attemptCount: 0,
      maxRetries: input.maxRetries ?? 2,
      timeoutMs: input.timeoutMs ?? 900000,
      branchName: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    }
    this.database.prepare(`
      INSERT INTO tasks (
        id, repository_id, channel_id, direct_agent_id, title, description, acceptance_criteria,
        labels_json, status, queued_at, attempt_count, max_retries, timeout_ms, branch_name,
        worktree_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.repositoryId, task.channelId, task.directAgentId, task.title, task.description,
      task.acceptanceCriteria, JSON.stringify(task.labels), task.status, task.queuedAt,
      task.attemptCount, task.maxRetries, task.timeoutMs, task.branchName, task.worktreePath,
      task.createdAt, task.updatedAt,
    )
    this.afterCommit(event('task.created', 'task', task.id, createdAt))
    return task
  }

  createMessage(input: CreateMessageInput): Message {
    const createdAt = now()
    const message: Message = {
      id: randomUUID(),
      channelId: input.channelId,
      taskId: input.taskId ?? null,
      senderType: input.senderType,
      senderId: input.senderId ?? null,
      authorName: requireText(input.authorName, 'Message author'),
      body: requireText(input.body, 'Message body'),
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    }
    this.database.prepare(`
      INSERT INTO messages (
        id, channel_id, task_id, sender_type, sender_id, author_name, body, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id, message.channelId, message.taskId, message.senderType, message.senderId,
      message.authorName, message.body, message.createdAt, message.updatedAt, message.deletedAt,
    )
    this.afterCommit(event('message.created', 'message', message.id, createdAt))
    return message
  }

  updateMessageBody(messageId: string, body: string): Message {
    const existing = readMessage(this.database, messageId)
    if (!existing) {
      throw new Error(`Message ${messageId} does not exist.`)
    }
    const updatedAt = now()
    const updatedBody = requireText(body, 'Message body')
    this.database.prepare('UPDATE messages SET body = ?, updated_at = ? WHERE id = ?').run(updatedBody, updatedAt, messageId)
    this.afterCommit(event('message.updated', 'message', messageId, updatedAt))
    return { ...existing, body: updatedBody, updatedAt }
  }

  deleteMessage(messageId: string): void {
    if (!readMessage(this.database, messageId)) {
      throw new Error(`Message ${messageId} does not exist.`)
    }
    const deletedAt = now()
    this.database.prepare('UPDATE messages SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deletedAt, deletedAt, messageId)
    this.afterCommit(event('message.deleted', 'message', messageId, deletedAt))
  }

  transitionTask(taskId: string, next: TaskStatus, reason: string): Task {
    const task = readTask(this.database, taskId)
    if (!task) {
      throw new Error(`Task ${taskId} does not exist.`)
    }
    const transitioned = transitionTaskDomain(task, next, reason)
    this.database.prepare('UPDATE tasks SET status = ?, queued_at = ?, updated_at = ? WHERE id = ?').run(
      transitioned.status,
      transitioned.queuedAt,
      transitioned.updatedAt,
      taskId,
    )
    this.database.prepare('INSERT INTO task_events (id, task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(),
      taskId,
      'task.status_changed',
      JSON.stringify({ from: task.status, to: next, reason }),
      transitioned.updatedAt,
    )
    this.afterCommit(event('task.status_changed', 'task', taskId, transitioned.updatedAt))
    return transitioned
  }

  afterCommit(domainEvent: DomainEvent): void {
    this.events.push(domainEvent)
  }

  publishCommittedEvents(): void {
    for (const domainEvent of this.events) {
      this.publisher.publish(domainEvent)
    }
  }
}

export class SqliteRepositories implements WorkspaceRepositories {
  constructor(
    private readonly sqlite: SqliteDatabase,
    private readonly publisher: DomainEventPublisher,
  ) {}

  inTransaction<T>(work: (unitOfWork: SqliteUnitOfWork) => T): T {
    const unitOfWork = new SqliteUnitOfWork(this.sqlite.database, this.publisher)
    const result = this.sqlite.transaction(() => work(unitOfWork))
    unitOfWork.publishCommittedEvents()
    return result
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    return this.inTransaction((unitOfWork) => unitOfWork.createWorkspace(input))
  }

  createRepository(input: CreateRepositoryInput): Repository {
    return this.inTransaction((unitOfWork) => unitOfWork.createRepository(input))
  }

  createChannel(input: CreateChannelInput): Channel {
    return this.inTransaction((unitOfWork) => unitOfWork.createChannel(input))
  }

  createTask(input: CreateTaskInput): Task {
    return this.inTransaction((unitOfWork) => unitOfWork.createTask(input))
  }

  createMessage(input: CreateMessageInput): Message {
    return this.inTransaction((unitOfWork) => unitOfWork.createMessage(input))
  }

  updateMessageBody(messageId: string, body: string): Message {
    return this.inTransaction((unitOfWork) => unitOfWork.updateMessageBody(messageId, body))
  }

  deleteMessage(messageId: string): void {
    this.inTransaction((unitOfWork) => unitOfWork.deleteMessage(messageId))
  }

  transitionTask(taskId: string, next: TaskStatus, reason: string): Task {
    return this.inTransaction((unitOfWork) => unitOfWork.transitionTask(taskId, next, reason))
  }

  getTask(taskId: string): Task | undefined {
    return readTask(this.sqlite.database, taskId)
  }

  getMessage(messageId: string): Message | undefined {
    return readMessage(this.sqlite.database, messageId)
  }

  getBootstrap(): BootstrapSnapshot {
    const workspaces = this.sqlite.database.prepare('SELECT id, name, created_at FROM workspaces ORDER BY created_at').all() as unknown as WorkspaceRow[]
    return {
      workspaces: workspaces.map((workspaceRow) => {
        const workspace = mapWorkspace(workspaceRow)
        const repositories = (this.sqlite.database.prepare('SELECT id, workspace_id, name, path, created_at FROM repositories WHERE workspace_id = ? ORDER BY created_at').all(workspace.id) as unknown as RepositoryRow[])
          .map((repositoryRow) => {
            const repository = mapRepository(repositoryRow)
            const channels = (this.sqlite.database.prepare('SELECT id, repository_id, name, created_at FROM channels WHERE repository_id = ? ORDER BY created_at').all(repository.id) as unknown as ChannelRow[])
              .map(mapChannel)
            const tasks = (this.sqlite.database.prepare('SELECT * FROM tasks WHERE repository_id = ? ORDER BY queued_at').all(repository.id) as unknown as TaskRow[])
              .map(mapTask)
            return { ...repository, channels, tasks }
          })
        const agents = (this.sqlite.database.prepare('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at').all(workspace.id) as unknown as AgentRow[])
          .map(mapAgent)
        const recentMessages = (this.sqlite.database.prepare(`
          SELECT messages.* FROM messages
          JOIN channels ON channels.id = messages.channel_id
          JOIN repositories ON repositories.id = channels.repository_id
          WHERE repositories.workspace_id = ? AND messages.deleted_at IS NULL
          ORDER BY messages.created_at DESC LIMIT 50
        `).all(workspace.id) as unknown as MessageRow[])
          .map(mapMessage)
          .reverse()
        return { ...workspace, agents, repositories, recentMessages }
      }),
    }
  }
}

function readTask(database: DatabaseSync, taskId: string): Task | undefined {
  const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  return row ? mapTask(row) : undefined
}

function readMessage(database: DatabaseSync, messageId: string): Message | undefined {
  const row = database.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined
  return row ? mapMessage(row) : undefined
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, createdAt: row.created_at }
}

function mapRepository(row: RepositoryRow): Repository {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, path: row.path, createdAt: row.created_at }
}

function mapChannel(row: ChannelRow): Channel {
  return { id: row.id, repositoryId: row.repository_id, name: row.name, createdAt: row.created_at }
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    channelId: row.channel_id,
    directAgentId: row.direct_agent_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    labels: JSON.parse(row.labels_json) as string[],
    status: row.status,
    queuedAt: row.queued_at,
    attemptCount: row.attempt_count,
    maxRetries: row.max_retries,
    timeoutMs: row.timeout_ms,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    taskId: row.task_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mentionName: row.mention_name,
    runtime: row.runtime,
    status: row.status,
    capabilityTags: JSON.parse(row.capability_tags_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function event(type: string, entityType: string, entityId: string, occurredAt: string): DomainEvent {
  return { id: randomUUID(), type, occurredAt, entityType, entityId }
}

function now(): string {
  return new Date().toISOString()
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} is required.`)
  }
  return trimmed
}
