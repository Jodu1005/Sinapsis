import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Agent, AgentStatus, CreateAgentInput } from '../../domain/agent'
import type { DomainEvent } from '../../domain/events'
import type { CreateMessageInput, Message, MessageSenderType } from '../../domain/message'
import {
  DomainError,
  type CreateTaskInput,
  type ReviewDecision,
  type Task,
  type TaskArtifact,
  type TaskDetails,
  type TaskEventRecord,
  type TaskInput,
  type TaskLease,
  type TaskSession,
  type TaskStatus,
  transitionTask as transitionTaskDomain,
} from '../../domain/task'
import type {
  Channel,
  CreateChannelInput,
  CreateRepositoryInput,
  CreateWorkspaceInput,
  Repository,
  Workspace,
} from '../../domain/workspace'
import type { DomainEventPublisher } from '../../ports/domain-event-publisher'
import type {
  BootstrapSnapshot,
  ExpiredLease,
  LeaseRecovery,
  TaskClaim,
  WorkspaceRepositories,
  WorkspaceUnitOfWork,
} from '../../ports/repositories'
import type { SqliteDatabase } from './database'
import { summitSystemKey } from '../../../shared/channel-policy'

interface WorkspaceRow {
  id: string
  name: string
  lease_ttl_ms: number
  created_at: string
}

interface RepositoryRow {
  id: string
  workspace_id: string
  name: string
  path: string
  current_branch: string
  default_branch: string
  is_clean: number
  created_at: string
}

interface ChannelRow {
  id: string
  repository_id: string
  name: string
  system_key: string | null
  archived_at: string | null
  context_reset_at: string | null
  created_at: string
}

interface TaskRow {
  id: string
  workspace_id: string
  repository_id: string
  channel_id: string
  thread_root_message_id: string | null
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
  lease_ttl_ms: number | null
  branch_name: string | null
  worktree_path: string | null
  created_at: string
  updated_at: string
}

interface TaskInputRow {
  id: string
  task_id: string
  body: string
  created_at: string
  consumed_at: string | null
}

interface TaskSessionRow {
  id: string
  task_id: string
  agent_id: string
  runtime_session_id: string | null
  status: string
  created_at: string
  updated_at: string
}

interface TaskLeaseRow {
  id: string
  task_id: string
  agent_id: string
  expires_at: string
  created_at: string
}

interface TaskArtifactRow {
  id: string
  task_id: string
  kind: string
  path: string
  created_at: string
}

interface TaskEventRow {
  id: string
  task_id: string
  type: string
  payload_json: string
  created_at: string
}

interface ReviewDecisionRow {
  id: string
  task_id: string
  decision: string
  reason: string
  created_at: string
}

interface MessageRow {
  id: string
  channel_id: string
  thread_root_id: string | null
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
  identity: string
  mention_name: string
  runtime: 'opencode' | 'pi' | 'claude-code'
  status: Agent['status']
  capability_tags_json: string
  responsibilities_json: string
  max_concurrent_tasks: 1
  command: string
  args_json: string
  model: string
  env_json: string
  created_at: string
  updated_at: string
}

export class SqliteUnitOfWork implements WorkspaceUnitOfWork {
  constructor(
    private readonly database: DatabaseSync,
    private readonly deferUntilCommit: (domainEvent: DomainEvent) => void,
  ) {}

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const createdAt = now()
    const workspace: Workspace = {
      id: randomUUID(), name: requireText(input.name, 'Workspace name'),
      leaseTtlMs: positiveInteger(input.leaseTtlMs ?? 30_000, 'Workspace lease TTL'), createdAt,
    }
    this.database.prepare('INSERT INTO workspaces (id, name, lease_ttl_ms, created_at) VALUES (?, ?, ?, ?)').run(
      workspace.id, workspace.name, workspace.leaseTtlMs, workspace.createdAt,
    )
    return workspace
  }

  createRepository(input: CreateRepositoryInput): Repository {
    const createdAt = now()
    const repository: Repository = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: requireText(input.name, 'Repository name'),
      path: requireText(input.path, 'Repository path'),
      currentBranch: input.currentBranch ?? '',
      defaultBranch: input.defaultBranch ?? '',
      isClean: input.isClean ?? true,
      createdAt,
    }
    this.database.prepare(`
      INSERT INTO repositories (id, workspace_id, name, path, current_branch, default_branch, is_clean, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repository.id,
      repository.workspaceId,
      repository.name,
      repository.path,
      repository.currentBranch,
      repository.defaultBranch,
      repository.isClean ? 1 : 0,
      repository.createdAt,
    )
    return repository
  }

  createChannel(input: CreateChannelInput): Channel
  createChannel(input: CreateChannelInput): Channel {
    const createdAt = now()
    const repositoryId = oldestRepositoryId(this.database)
    if (!repositoryId) throw new DomainError('A global Channel requires an existing Repository.')
    const normalizedName = requireText(input.name, 'Channel name')
    const systemKey = input.systemKey ?? null
    const channel = {
      id: randomUUID(),
      name: normalizedName,
      systemKey,
      memberAgentIds: [],
      boundWorkspaceIds: [],
      createdAt,
    }
    this.database.prepare('INSERT INTO channels (id, repository_id, name, system_key, archived_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      channel.id, repositoryId, channel.name, channel.systemKey, null, channel.createdAt,
    )
    return readChannel(this.database, channel.id)!
  }

  ensureSystemChannel(input: CreateChannelInput & { systemKey: string }): Channel {
    const row = this.database.prepare('SELECT * FROM channels WHERE system_key = ? LIMIT 1').get(input.systemKey) as ChannelRow | undefined
    return row ? mapChannel(this.database, row) : this.createChannel(input)
  }

  archiveChannel(channelId: string, occurredAt: Date): Channel {
    const channel = readChannel(this.database, channelId)
    if (!channel) throw new Error(`Channel ${channelId} does not exist.`)
    if (channel.archivedAt) return channel
    const activeTask = this.database.prepare(`
      SELECT id FROM tasks WHERE channel_id = ? AND status NOT IN ('accepted', 'merged', 'cancelled') LIMIT 1
    `).get(channelId)
    if (activeTask) throw new DomainError(`Channel #${channel.name} has unfinished tasks and cannot be archived.`)
    const archivedAt = occurredAt.toISOString()
    this.database.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(archivedAt, channelId)
    this.afterCommit(event('channel.changed', 'channel', channelId, archivedAt))
    return { ...channel, archivedAt }
  }

  restoreChannel(channelId: string, occurredAt: Date): Channel {
    const channel = readChannel(this.database, channelId)
    if (!channel) throw new Error(`Channel ${channelId} does not exist.`)
    if (!channel.archivedAt) return channel
    const conflictingChannel = this.database.prepare(`
      SELECT id FROM channels WHERE lower(trim(name)) = lower(trim(?)) AND archived_at IS NULL AND id != ? LIMIT 1
    `).get(channel.name, channelId)
    if (conflictingChannel) throw new DomainError(`Channel #${channel.name} already exists.`)
    const updatedAt = occurredAt.toISOString()
    this.database.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?').run(channelId)
    this.afterCommit(event('channel.changed', 'channel', channelId, updatedAt))
    return { ...channel, archivedAt: null }
  }

  resetChannelContext(channelId: string, occurredAt: Date): Channel {
    const channel = readChannel(this.database, channelId)
    if (!channel) throw new Error(`Channel ${channelId} does not exist.`)
    const contextResetAt = occurredAt.toISOString()
    this.database.prepare('UPDATE channels SET context_reset_at = ? WHERE id = ?').run(contextResetAt, channelId)
    this.afterCommit(event('channel.changed', 'channel', channelId, contextResetAt))
    return { ...channel, contextResetAt }
  }

  createAgent(input: CreateAgentInput): Agent {
    const createdAt = now()
    const workspaceId = oldestWorkspaceId(this.database)
    if (!workspaceId) throw new DomainError('A global Agent requires an existing Workspace.')
    const agent: Agent = {
      id: randomUUID(),
      identity: requireText(input.identity, 'Agent identity'),
      mentionName: requireText(input.mentionName, 'Agent mention'),
      runtime: input.runtime,
      status: 'offline',
      capabilityTags: input.capabilityTags,
      responsibilities: input.responsibilities ?? [],
      maxConcurrentTasks: input.maxConcurrentTasks,
      command: requireText(input.command, 'Runtime command'),
      args: input.args,
      model: input.model,
      env: input.env,
      createdAt,
      updatedAt: createdAt,
    }
    try {
      this.database.prepare(`
        INSERT INTO agents (
          id, workspace_id, identity, mention_name, runtime, status, capability_tags_json, responsibilities_json,
          max_concurrent_tasks, command, args_json, model, env_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agent.id, workspaceId, agent.identity, agent.mentionName, agent.runtime, agent.status,
        JSON.stringify(agent.capabilityTags), JSON.stringify(agent.responsibilities), agent.maxConcurrentTasks, agent.command, JSON.stringify(agent.args),
        agent.model, JSON.stringify(agent.env), agent.createdAt, agent.updatedAt,
      )
    } catch (error) {
      if (isGlobalAgentMentionConstraint(error)) {
        throw new DomainError(`Agent mention @${agent.mentionName} already exists globally.`)
      }
      throw error
    }
    return agent
  }

  updateAgentResponsibilities(agentId: string, responsibilities: string[]): Agent {
    const agent = readAgent(this.database, agentId)
    if (!agent) throw new Error(`Agent ${agentId} does not exist.`)
    const updatedAt = now()
    this.database.prepare('UPDATE agents SET responsibilities_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(responsibilities), updatedAt, agentId,
    )
    this.afterCommit(event('agent.configuration_changed', 'agent', agentId, updatedAt))
    return { ...agent, responsibilities, updatedAt }
  }

  createTask(input: CreateTaskInput): Task {
    const createdAt = now()
    const workspaceId = input.workspaceId ?? workspaceIdForRepository(this.database, input.repositoryId)
    if (!workspaceId) throw new DomainError(`Task repository ${input.repositoryId} does not belong to a Workspace.`)
    const task: Task = {
      id: randomUUID(),
      workspaceId,
      repositoryId: input.repositoryId,
      channelId: input.channelId,
      threadRootMessageId: input.threadRootMessageId ?? null,
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
      leaseTtlMs: input.leaseTtlMs === undefined ? null : positiveInteger(input.leaseTtlMs, 'Task lease TTL'),
      branchName: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    }
    this.database.prepare(`
      INSERT INTO tasks (
        id, workspace_id, repository_id, channel_id, thread_root_message_id, direct_agent_id, title, description, acceptance_criteria,
        labels_json, status, queued_at, attempt_count, max_retries, timeout_ms, lease_ttl_ms, branch_name,
        worktree_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, workspaceId, task.repositoryId, task.channelId, task.threadRootMessageId ?? null, task.directAgentId, task.title, task.description,
      task.acceptanceCriteria, JSON.stringify(task.labels), task.status, task.queuedAt,
      task.attemptCount, task.maxRetries, task.timeoutMs, task.leaseTtlMs, task.branchName, task.worktreePath,
      task.createdAt, task.updatedAt,
    )
    this.afterCommit(event('task.created', 'task', task.id, createdAt))
    return task
  }

  createTaskInput(taskId: string, body: string): TaskInput {
    if (!readTask(this.database, taskId)) {
      throw new Error(`Task ${taskId} does not exist.`)
    }
    const input: TaskInput = {
      id: randomUUID(), taskId, body: requireText(body, 'Task input'), createdAt: now(), consumedAt: null,
    }
    this.database.prepare(`
      INSERT INTO task_input_queue (id, task_id, body, created_at, consumed_at) VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.taskId, input.body, input.createdAt, input.consumedAt)
    this.recordTaskEvent(taskId, 'task.input_queued', { inputId: input.id })
    return input
  }

  createMessage(input: CreateMessageInput): Message {
    const channel = readChannel(this.database, input.channelId)
    if (!channel) throw new Error(`Channel ${input.channelId} does not exist.`)
    if (channel.archivedAt) throw new DomainError(`Channel #${channel.name} is archived and read-only.`)
    if (input.threadRootMessageId) {
      const root = readMessage(this.database, input.threadRootMessageId)
      if (!root || root.channelId !== input.channelId || root.threadRootMessageId) {
        throw new Error('Thread root must be a root message in the same channel.')
      }
    }
    const createdAt = now()
    const message: Message = {
      id: randomUUID(),
      channelId: input.channelId,
      threadRootMessageId: input.threadRootMessageId ?? null,
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
        id, channel_id, thread_root_id, task_id, sender_type, sender_id, author_name, body, created_at, updated_at, deleted_at
      ) VALUES ($id, $channelId, $threadRootMessageId, $taskId, $senderType, $senderId, $authorName, $body, $createdAt, $updatedAt, $deletedAt)
    `).run({
      id: message.id,
      channelId: message.channelId,
      threadRootMessageId: message.threadRootMessageId ?? null,
      taskId: message.taskId,
      senderType: message.senderType,
      senderId: message.senderId,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      deletedAt: message.deletedAt,
    })
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
    if (next === 'cancelled') {
      const leases = this.database.prepare('SELECT * FROM task_leases WHERE task_id = ?').all(taskId) as unknown as TaskLeaseRow[]
      this.database.prepare('DELETE FROM task_leases WHERE task_id = ?').run(taskId)
      for (const lease of leases) {
        this.database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('idle', transitioned.updatedAt, lease.agent_id)
        this.afterCommit(event('agent.status_changed', 'agent', lease.agent_id, transitioned.updatedAt))
      }
    }
    this.afterCommit(event('task.status_changed', 'task', taskId, transitioned.updatedAt))
    return transitioned
  }

  allocateTaskWorktree(taskId: string, branchName: string, worktreePath: string): Task {
    const task = readTask(this.database, taskId)
    if (!task) throw new Error(`Task ${taskId} does not exist.`)
    const updatedAt = now()
    this.database.prepare('UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?').run(
      requireText(branchName, 'Task branch name'), requireText(worktreePath, 'Task worktree path'), updatedAt, taskId,
    )
    this.recordTaskEvent(taskId, 'task.worktree_allocated', { branchName, worktreePath })
    return { ...task, branchName, worktreePath, updatedAt }
  }

  createTaskSession(taskId: string, agentId: string): TaskSession {
    if (!readTask(this.database, taskId)) throw new Error(`Task ${taskId} does not exist.`)
    if (!readAgent(this.database, agentId)) throw new Error(`Agent ${agentId} does not exist.`)
    const createdAt = now()
    const session: TaskSession = {
      id: randomUUID(), taskId, agentId, runtimeSessionId: null, status: 'preparing', createdAt, updatedAt: createdAt,
    }
    this.database.prepare(`
      INSERT INTO task_sessions (id, task_id, agent_id, runtime_session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.taskId, session.agentId, session.runtimeSessionId, session.status, session.createdAt, session.updatedAt)
    this.recordTaskEvent(taskId, 'task.session_created', { sessionId: session.id, agentId })
    return session
  }

  updateTaskSession(taskId: string, agentId: string, input: { runtimeSessionId?: string | null; status?: string }): TaskSession {
    const session = this.database.prepare(`
      SELECT * FROM task_sessions WHERE task_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId, agentId) as TaskSessionRow | undefined
    if (!session) throw new Error(`No task session exists for task ${taskId} and agent ${agentId}.`)
    const updatedAt = now()
    const runtimeSessionId = input.runtimeSessionId === undefined ? session.runtime_session_id : input.runtimeSessionId
    const status = input.status ?? session.status
    this.database.prepare('UPDATE task_sessions SET runtime_session_id = ?, status = ?, updated_at = ? WHERE id = ?').run(
      runtimeSessionId, status, updatedAt, session.id,
    )
    this.recordTaskEvent(taskId, 'task.session_updated', { sessionId: session.id, status })
    return { ...mapTaskSession(session), runtimeSessionId, status, updatedAt }
  }

  consumeTaskInput(inputId: string): TaskInput {
    const input = this.database.prepare('SELECT * FROM task_input_queue WHERE id = ?').get(inputId) as TaskInputRow | undefined
    if (!input) throw new Error(`Task input ${inputId} does not exist.`)
    const consumedAt = now()
    this.database.prepare('UPDATE task_input_queue SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(consumedAt, inputId)
    return { ...mapTaskInput(input), consumedAt }
  }

  createTaskArtifact(taskId: string, kind: string, artifactPath: string): TaskArtifact {
    if (!readTask(this.database, taskId)) throw new Error(`Task ${taskId} does not exist.`)
    const artifact: TaskArtifact = { id: randomUUID(), taskId, kind: requireText(kind, 'Artifact kind'), path: requireText(artifactPath, 'Artifact path'), createdAt: now() }
    this.database.prepare('INSERT INTO task_artifacts (id, task_id, kind, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      artifact.id, artifact.taskId, artifact.kind, artifact.path, artifact.createdAt,
    )
    this.afterCommit(event('task.artifact_created', 'task', taskId, artifact.createdAt))
    return artifact
  }

  createReviewDecision(taskId: string, decision: string, reason: string): void {
    if (!readTask(this.database, taskId)) throw new Error(`Task ${taskId} does not exist.`)
    const createdAt = now()
    this.database.prepare('INSERT INTO review_decisions (id, task_id, decision, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(), taskId, requireText(decision, 'Review decision'), requireText(reason, 'Review reason'), createdAt,
    )
    this.afterCommit(event('task.review_recorded', 'task', taskId, createdAt))
  }

  recordTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    if (!readTask(this.database, taskId)) {
      throw new Error(`Task ${taskId} does not exist.`)
    }
    const createdAt = now()
    this.database.prepare('INSERT INTO task_events (id, task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(), taskId, requireText(type, 'Task event type'), JSON.stringify(payload), createdAt,
    )
    this.afterCommit(event(type, 'task', taskId, createdAt))
  }

  afterCommit(domainEvent: DomainEvent): void {
    this.deferUntilCommit(domainEvent)
  }
}

export class SqliteRepositories implements WorkspaceRepositories {
  constructor(
    private readonly sqlite: SqliteDatabase,
    private readonly publisher: DomainEventPublisher,
  ) {}

  inTransaction<T>(work: (unitOfWork: SqliteUnitOfWork) => T): T {
    const unitOfWork = new SqliteUnitOfWork(this.sqlite.database, (domainEvent) => {
      this.sqlite.afterCommit(() => this.publisher.publish(domainEvent))
    })

    return this.sqlite.transaction(() => work(unitOfWork))
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    return this.inTransaction((unitOfWork) => unitOfWork.createWorkspace(input))
  }

  createRepository(input: CreateRepositoryInput): Repository {
    return this.inTransaction((unitOfWork) => unitOfWork.createRepository(input))
  }

  createChannel(input: CreateChannelInput): Channel
  createChannel(input: CreateChannelInput): Channel {
    return this.inTransaction((unitOfWork) => unitOfWork.createChannel(input))
  }

  archiveChannel(channelId: string, occurredAt: Date): Channel {
    return this.inTransaction((unitOfWork) => unitOfWork.archiveChannel(channelId, occurredAt))
  }

  restoreChannel(channelId: string, occurredAt: Date): Channel {
    return this.inTransaction((unitOfWork) => unitOfWork.restoreChannel(channelId, occurredAt))
  }

  resetChannelContext(channelId: string, occurredAt: Date): Channel {
    return this.inTransaction((unitOfWork) => unitOfWork.resetChannelContext(channelId, occurredAt))
  }

  createAgent(input: CreateAgentInput): Agent {
    return this.inTransaction((unitOfWork) => unitOfWork.createAgent(input))
  }

  updateAgentResponsibilities(agentId: string, responsibilities: string[]): Agent {
    return this.inTransaction((unitOfWork) => unitOfWork.updateAgentResponsibilities(agentId, responsibilities))
  }

  createTask(input: CreateTaskInput): Task {
    return this.inTransaction((unitOfWork) => unitOfWork.createTask(input))
  }

  createTaskInput(taskId: string, body: string): TaskInput {
    return this.inTransaction((unitOfWork) => unitOfWork.createTaskInput(taskId, body))
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

  allocateTaskWorktree(taskId: string, branchName: string, worktreePath: string): Task {
    return this.inTransaction((unitOfWork) => unitOfWork.allocateTaskWorktree(taskId, branchName, worktreePath))
  }

  createTaskSession(taskId: string, agentId: string): TaskSession {
    return this.inTransaction((unitOfWork) => unitOfWork.createTaskSession(taskId, agentId))
  }

  updateTaskSession(taskId: string, agentId: string, input: { runtimeSessionId?: string | null; status?: string }): TaskSession {
    return this.inTransaction((unitOfWork) => unitOfWork.updateTaskSession(taskId, agentId, input))
  }

  consumeTaskInput(inputId: string): TaskInput {
    return this.inTransaction((unitOfWork) => unitOfWork.consumeTaskInput(inputId))
  }

  createTaskArtifact(taskId: string, kind: string, artifactPath: string): TaskArtifact {
    return this.inTransaction((unitOfWork) => unitOfWork.createTaskArtifact(taskId, kind, artifactPath))
  }

  createReviewDecision(taskId: string, decision: string, reason: string): void {
    this.inTransaction((unitOfWork) => unitOfWork.createReviewDecision(taskId, decision, reason))
  }

  finishTaskExecution(taskId: string, agentId: string, next: Extract<TaskStatus, 'in_review' | 'needs_human' | 'cancelled'>, reason: string): Task {
    return this.inTransaction((unitOfWork) => {
      const task = readTask(this.sqlite.database, taskId)
      if (!task) throw new Error(`Task ${taskId} does not exist.`)
      const transitioned = unitOfWork.transitionTask(taskId, next, reason)
      const updatedAt = new Date(transitioned.updatedAt)
      this.sqlite.database.prepare('DELETE FROM task_leases WHERE task_id = ? AND agent_id = ?').run(taskId, agentId)
      this.sqlite.database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('idle', transitioned.updatedAt, agentId)
      const sessionStatus = next === 'in_review' ? 'completed' : next === 'cancelled' ? 'cancelled' : 'failed'
      const sessionUpdate = this.sqlite.database.prepare(`
        UPDATE task_sessions SET status = ?, updated_at = ?
        WHERE id = (
          SELECT id FROM task_sessions WHERE task_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
        ) AND status <> 'timed_out'
      `).run(sessionStatus, transitioned.updatedAt, taskId, agentId)
      if (Number(sessionUpdate.changes) === 1) {
        unitOfWork.recordTaskEvent(taskId, 'task.session_updated', { agentId, status: sessionStatus })
      }
      unitOfWork.afterCommit(event('agent.status_changed', 'agent', agentId, updatedAt.toISOString()))
      return transitioned
    })
  }

  getActiveTaskForAgent(agentId: string): Task | undefined {
    const row = this.sqlite.database.prepare(`
      SELECT tasks.* FROM tasks JOIN task_leases ON task_leases.task_id = tasks.id
      WHERE task_leases.agent_id = ? LIMIT 1
    `).get(agentId) as TaskRow | undefined
    return row ? mapTask(row) : undefined
  }

  reclaimReturnedTask(taskId: string, agentId: string, occurredAt: Date): TaskClaim | undefined {
    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const task = readTask(database, taskId)
      const agent = readAgent(database, agentId)
      if (!task || !agent || task.status !== 'returned' || agent.status !== 'idle') return undefined
      const claimed = unitOfWork.transitionTask(taskId, 'claimed', '人工退回后恢复原会话')
      const lease: TaskLease = {
        id: randomUUID(), taskId, agentId,
        expiresAt: new Date(occurredAt.getTime() + resolveLeaseTtlMs(database, task)).toISOString(), createdAt: occurredAt.toISOString(),
      }
      database.prepare('INSERT INTO task_leases (id, task_id, agent_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
        lease.id, lease.taskId, lease.agentId, lease.expiresAt, lease.createdAt,
      )
      database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('busy', occurredAt.toISOString(), agentId)
      unitOfWork.afterCommit(event('agent.status_changed', 'agent', agentId, occurredAt.toISOString()))
      return { task: claimed, lease }
    })
  }

  getTask(taskId: string): Task | undefined {
    return readTask(this.sqlite.database, taskId)
  }

  getAgent(agentId: string): Agent | undefined {
    return readAgent(this.sqlite.database, agentId)
  }

  getRepository(repositoryId: string): Repository | undefined {
    const row = this.sqlite.database.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId) as RepositoryRow | undefined
    return row ? mapRepository(row) : undefined
  }

  getTasksForRepository(repositoryId: string): Task[] {
    return (this.sqlite.database.prepare('SELECT * FROM tasks WHERE repository_id = ? ORDER BY queued_at').all(repositoryId) as unknown as TaskRow[])
      .map(mapTask)
  }

  getTasksForChannel(channelId: string): Task[] {
    return (this.sqlite.database.prepare('SELECT * FROM tasks WHERE channel_id = ? ORDER BY queued_at').all(channelId) as unknown as TaskRow[])
      .map(mapTask)
  }

  getTaskDetails(taskId: string): TaskDetails | undefined {
    const task = this.getTask(taskId)
    if (!task) return undefined
    const database = this.sqlite.database
    return {
      task,
      sessions: (database.prepare('SELECT * FROM task_sessions WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as TaskSessionRow[]).map(mapTaskSession),
      leases: (database.prepare('SELECT * FROM task_leases WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as TaskLeaseRow[]).map(mapTaskLease),
      inputs: (database.prepare('SELECT * FROM task_input_queue WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as TaskInputRow[]).map(mapTaskInput),
      decisions: (database.prepare('SELECT * FROM review_decisions WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as ReviewDecisionRow[]).map(mapReviewDecision),
      artifacts: (database.prepare('SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as TaskArtifactRow[]).map(mapTaskArtifact),
      events: (database.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as TaskEventRow[]).map(mapTaskEvent),
    }
  }

  getTaskArtifact(taskId: string, artifactId: string): TaskArtifact | undefined {
    const row = this.sqlite.database.prepare('SELECT * FROM task_artifacts WHERE task_id = ? AND id = ?').get(taskId, artifactId) as TaskArtifactRow | undefined
    return row ? mapTaskArtifact(row) : undefined
  }

  getMessage(messageId: string): Message | undefined {
    return readMessage(this.sqlite.database, messageId)
  }

  getChannel(channelId: string): Channel | undefined {
    return readChannel(this.sqlite.database, channelId)
  }

  listAgents(): Agent[] {
    return (this.sqlite.database.prepare('SELECT * FROM agents ORDER BY created_at, id').all() as unknown as AgentRow[]).map(mapAgent)
  }

  getChannelAgentIds(channelId: string): string[] {
    const channel = readChannel(this.sqlite.database, channelId)
    if (!channel) return []
    if (channel.systemKey === summitSystemKey) return this.listAgents().map((agent) => agent.id)
    return (this.sqlite.database.prepare(
      'SELECT agent_id FROM channel_agent_memberships WHERE channel_id = ? ORDER BY agent_id',
    ).all(channelId) as Array<{ agent_id: string }>).map((row) => row.agent_id)
  }

  addChannelAgent(channelId: string, agentId: string, occurredAt: Date): void {
    this.inTransaction(() => {
      const channel = readChannel(this.sqlite.database, channelId)
      if (!channel) throw new Error(`Channel ${channelId} does not exist.`)
      if (channel.systemKey === summitSystemKey) throw new DomainError('Summit membership is managed dynamically.')
      if (!readAgent(this.sqlite.database, agentId)) throw new Error(`Agent ${agentId} does not exist.`)
      this.sqlite.database.prepare(`
        INSERT OR IGNORE INTO channel_agent_memberships (channel_id, agent_id, created_at) VALUES (?, ?, ?)
      `).run(channelId, agentId, occurredAt.toISOString())
    })
  }

  removeChannelAgent(channelId: string, agentId: string): void {
    this.inTransaction(() => {
      const channel = readChannel(this.sqlite.database, channelId)
      if (!channel) throw new Error(`Channel ${channelId} does not exist.`)
      if (channel.systemKey === summitSystemKey) throw new DomainError('Summit membership is managed dynamically.')
      this.sqlite.database.prepare('DELETE FROM channel_agent_memberships WHERE channel_id = ? AND agent_id = ?').run(channelId, agentId)
    })
  }

  getChannelWorkspaceIds(channelId: string): string[] {
    return (this.sqlite.database.prepare(
      'SELECT workspace_id FROM channel_workspace_bindings WHERE channel_id = ? ORDER BY workspace_id',
    ).all(channelId) as Array<{ workspace_id: string }>).map((row) => row.workspace_id)
  }

  bindChannelWorkspace(channelId: string, workspaceId: string, occurredAt: Date): void {
    this.inTransaction(() => {
      if (!readChannel(this.sqlite.database, channelId)) throw new Error(`Channel ${channelId} does not exist.`)
      const workspace = this.sqlite.database.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} does not exist.`)
      this.sqlite.database.prepare(`
        INSERT OR IGNORE INTO channel_workspace_bindings (channel_id, workspace_id, created_at) VALUES (?, ?, ?)
      `).run(channelId, workspaceId, occurredAt.toISOString())
    })
  }

  unbindChannelWorkspace(channelId: string, workspaceId: string): void {
    this.inTransaction(() => {
      if (!readChannel(this.sqlite.database, channelId)) throw new Error(`Channel ${channelId} does not exist.`)
      this.sqlite.database.prepare('DELETE FROM channel_workspace_bindings WHERE channel_id = ? AND workspace_id = ?').run(channelId, workspaceId)
    })
  }

  hasUnfinishedTask(channelId: string, workspaceId: string, agentId?: string): boolean {
    const row = agentId
      ? this.sqlite.database.prepare(`
          SELECT 1 FROM tasks WHERE channel_id = ? AND workspace_id = ?
          AND (
            direct_agent_id = ?
            OR EXISTS (SELECT 1 FROM task_leases WHERE task_leases.task_id = tasks.id AND task_leases.agent_id = ?)
          )
          AND status NOT IN ('accepted', 'merged', 'cancelled') LIMIT 1
        `).get(channelId, workspaceId, agentId, agentId)
      : this.sqlite.database.prepare(`
          SELECT 1 FROM tasks WHERE channel_id = ? AND workspace_id = ?
          AND status NOT IN ('accepted', 'merged', 'cancelled') LIMIT 1
        `).get(channelId, workspaceId)
    return row !== undefined
  }

  hasAgentMention(mention: string): boolean {
    const row = this.sqlite.database.prepare(
      'SELECT 1 FROM agents WHERE lower(trim(mention_name)) = lower(trim(?)) LIMIT 1',
    ).get(mention)
    return row !== undefined
  }

  getIdleAgentIds(): string[] {
    return (this.sqlite.database.prepare('SELECT id FROM agents WHERE status = ? ORDER BY updated_at, id').all('idle') as Array<{ id: string }>)
      .map((agent) => agent.id)
  }

  recoverOrphanedAgents(occurredAt: Date): number {
    return this.inTransaction((unitOfWork) => {
      const orphaned = this.sqlite.database.prepare(`
        SELECT id FROM agents
        WHERE status = 'busy'
          AND NOT EXISTS (SELECT 1 FROM task_leases WHERE task_leases.agent_id = agents.id)
      `).all() as Array<{ id: string }>
      if (orphaned.length === 0) return 0

      const updatedAt = occurredAt.toISOString()
      const reset = this.sqlite.database.prepare("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?")
      for (const agent of orphaned) {
        reset.run(updatedAt, agent.id)
        unitOfWork.afterCommit(event('agent.status_changed', 'agent', agent.id, updatedAt))
      }
      return orphaned.length
    })
  }

  setAgentStatus(agentId: string, status: AgentStatus, occurredAt: Date): Agent {
    return this.inTransaction((unitOfWork) => {
      const agent = readAgent(this.sqlite.database, agentId)
      if (!agent) throw new Error(`Agent ${agentId} does not exist.`)
      const updatedAt = occurredAt.toISOString()
      this.sqlite.database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, agentId)
      unitOfWork.afterCommit(event('agent.status_changed', 'agent', agentId, updatedAt))
      return { ...agent, status, updatedAt }
    })
  }

  claimNextTask(agentId: string, occurredAt: Date): TaskClaim | undefined {
    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const agent = readAgent(database, agentId)
      if (!agent || agent.status !== 'idle' || hasActiveLease(database, agentId)) return undefined

      const occurredAtIso = occurredAt.toISOString()
      let candidate: Task | undefined
      while (true) {
        const candidates = (database.prepare(`
          SELECT * FROM tasks
          WHERE status = 'queued' AND (direct_agent_id IS NULL OR direct_agent_id = ?)
          ORDER BY queued_at ASC, rowid ASC
        `).all(agentId) as unknown as TaskRow[]).map(mapTask)
        candidate = candidates.find((task) => task.directAgentId === agent.id || labelsMatch(agent.capabilityTags, task.labels))
        if (!candidate) return undefined

        const taskUpdate = database.prepare(`
          UPDATE tasks SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'queued'
        `).run(occurredAtIso, candidate.id)
        if (Number(taskUpdate.changes) === 1) break
      }

      const lease: TaskLease = {
        id: randomUUID(), taskId: candidate.id, agentId,
        expiresAt: new Date(occurredAt.getTime() + resolveLeaseTtlMs(database, candidate)).toISOString(), createdAt: occurredAtIso,
      }
      database.prepare(`
        INSERT INTO task_leases (id, task_id, agent_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(lease.id, lease.taskId, lease.agentId, lease.expiresAt, lease.createdAt)
      const agentUpdate = database.prepare(`
        UPDATE agents SET status = 'busy', updated_at = ? WHERE id = ? AND status = 'idle'
      `).run(occurredAtIso, agentId)
      if (Number(agentUpdate.changes) !== 1) throw new Error(`Agent ${agentId} became unavailable while claiming a task.`)

      unitOfWork.recordTaskEvent(candidate.id, 'task.claimed', { agentId, leaseId: lease.id, expiresAt: lease.expiresAt })
      unitOfWork.afterCommit(event('agent.status_changed', 'agent', agentId, occurredAtIso))
      return { task: { ...candidate, status: 'claimed', updatedAt: occurredAtIso }, lease }
    })
  }

  renewTaskLease(taskId: string, agentId: string, occurredAt: Date): TaskLease | undefined {
    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const lease = readLeaseForTaskAgent(database, taskId, agentId)
      if (!lease) return undefined
      const task = readTask(database, taskId)
      if (!task) return undefined
      const expiresAt = new Date(occurredAt.getTime() + resolveLeaseTtlMs(database, task)).toISOString()
      const updated = database.prepare(`
        UPDATE task_leases SET expires_at = ? WHERE id = ? AND expires_at > ?
      `).run(expiresAt, lease.id, occurredAt.toISOString())
      if (Number(updated.changes) !== 1) return undefined
      unitOfWork.recordTaskEvent(taskId, 'task.lease_renewed', { agentId, leaseId: lease.id, expiresAt })
      return { ...lease, expiresAt }
    })
  }

  getActiveLeases(): TaskLease[] {
    return (this.sqlite.database.prepare('SELECT * FROM task_leases ORDER BY created_at, rowid').all() as unknown as TaskLeaseRow[])
      .map(mapTaskLease)
  }

  findExpiredLeases(occurredAt: Date): ExpiredLease[] {
    const leaseIds = this.sqlite.database.prepare(`
      SELECT id FROM task_leases WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC
    `).all(occurredAt.toISOString()) as Array<{ id: string }>
    return leaseIds.flatMap(({ id }) => {
      const lease = readLease(this.sqlite.database, id)
      if (!lease) return []
      const task = readTask(this.sqlite.database, lease.taskId)
      return task ? [{ lease, task }] : []
    })
  }

  markTimedOut(taskId: string, agentId: string, occurredAt: Date): void {
    this.inTransaction((unitOfWork) => {
      const task = readTask(this.sqlite.database, taskId)
      if (!task) return
      const occurredAtIso = occurredAt.toISOString()
      this.sqlite.database.prepare(`
        UPDATE task_sessions SET status = 'timed_out', updated_at = ?
        WHERE task_id = ? AND agent_id = ? AND status NOT IN ('completed', 'cancelled', 'failed', 'timed_out')
      `).run(occurredAtIso, taskId, agentId)
      unitOfWork.recordTaskEvent(taskId, 'task.session_timed_out', { agentId })
    })
  }

  takeExpiredLease(leaseId: string, occurredAt: Date): ExpiredLease | undefined {
    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const lease = readLease(database, leaseId)
      if (!lease || lease.expiresAt > occurredAt.toISOString()) return undefined
      const task = readTask(database, lease.taskId)
      if (!task) return undefined

      const leaseDeletion = database.prepare('DELETE FROM task_leases WHERE id = ? AND expires_at <= ?').run(lease.id, occurredAt.toISOString())
      if (Number(leaseDeletion.changes) !== 1) return undefined
      if (!canRecoverExpiredTask(task.status)) {
        database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('idle', occurredAt.toISOString(), lease.agentId)
        unitOfWork.afterCommit(event('agent.status_changed', 'agent', lease.agentId, occurredAt.toISOString()))
        return undefined
      }

      return { lease, task }
    })
  }

  finalizeExpiredLease(expiredLease: ExpiredLease, occurredAt: Date): LeaseRecovery | undefined {
    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const { lease } = expiredLease
      const task = readTask(database, lease.taskId)
      if (!task || !canRecoverExpiredTask(task.status)) {
        const updatedAt = occurredAt.toISOString()
        database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('idle', updatedAt, lease.agentId)
        unitOfWork.afterCommit(event('agent.status_changed', 'agent', lease.agentId, updatedAt))
        return undefined
      }

      const outcome = task.attemptCount < task.maxRetries ? 'requeued' : 'needs_human'
      const nextStatus = outcome === 'requeued' ? 'queued' : 'needs_human'
      const updatedAt = occurredAt.toISOString()
      const nextAttemptCount = outcome === 'requeued' ? task.attemptCount + 1 : task.attemptCount
      database.prepare(`
        UPDATE tasks SET status = ?, queued_at = ?, attempt_count = ?, updated_at = ? WHERE id = ? AND status = ?
      `).run(nextStatus, updatedAt, nextAttemptCount, updatedAt, task.id, task.status)
      database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('idle', updatedAt, lease.agentId)
      unitOfWork.recordTaskEvent(task.id, 'task.lease_expired', {
        agentId: lease.agentId, leaseId: lease.id, outcome, attemptCount: nextAttemptCount,
      })
      unitOfWork.createMessage({
        channelId: task.channelId,
        threadRootMessageId: task.threadRootMessageId,
        taskId: task.id,
        senderType: 'system',
        authorName: 'Sinapsis',
        body: outcome === 'requeued'
          ? `任务租约已超时，已重新进入 FIFO 队列（第 ${nextAttemptCount} 次重试）。`
          : '任务租约已超时，重试次数已用尽，等待人工处理。',
      })
      unitOfWork.afterCommit(event('agent.status_changed', 'agent', lease.agentId, updatedAt))
      return {
        task: { ...task, status: nextStatus, queuedAt: updatedAt, attemptCount: nextAttemptCount, updatedAt },
        lease,
        outcome,
      }
    })
  }

  failExpiredLeaseAfterSessionTimeoutPersistenceFailure(expiredLease: ExpiredLease, occurredAt: Date): boolean {
    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const { lease } = expiredLease
      const task = readTask(database, lease.taskId)
      const updatedAt = occurredAt.toISOString()

      database.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run('idle', updatedAt, lease.agentId)
      unitOfWork.afterCommit(event('agent.status_changed', 'agent', lease.agentId, updatedAt))

      if (!task || !canRecoverExpiredTask(task.status)) return false

      database.prepare(`
        UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?
      `).run('needs_human', updatedAt, task.id, task.status)
      unitOfWork.recordTaskEvent(task.id, 'task.session_timeout_persistence_failed', {
        agentId: lease.agentId,
        leaseId: lease.id,
      })
      unitOfWork.createMessage({
        channelId: task.channelId,
        threadRootMessageId: task.threadRootMessageId,
        taskId: task.id,
        senderType: 'system',
        authorName: 'Sinapsis',
        body: '任务租约已超时，但会话超时状态保存失败。为避免丢失运行上下文，任务已转为等待人工处理。',
      })
      return true
    })
  }

  getBootstrap(): BootstrapSnapshot {
    const workspaces = this.sqlite.database.prepare('SELECT id, name, lease_ttl_ms, created_at FROM workspaces ORDER BY created_at').all() as unknown as WorkspaceRow[]
    return {
      workspaces: workspaces.map((workspaceRow) => {
        const workspace = mapWorkspace(workspaceRow)
        const repositories = (this.sqlite.database.prepare('SELECT id, workspace_id, name, path, current_branch, default_branch, is_clean, created_at FROM repositories WHERE workspace_id = ? ORDER BY created_at').all(workspace.id) as unknown as RepositoryRow[])
          .map((repositoryRow) => {
            const repository = mapRepository(repositoryRow)
            const channels = (this.sqlite.database.prepare('SELECT id, repository_id, name, system_key, archived_at, context_reset_at, created_at FROM channels WHERE repository_id = ? ORDER BY archived_at IS NOT NULL, created_at').all(repository.id) as unknown as ChannelRow[])
              .map((channel) => mapChannel(this.sqlite.database, channel))
            const tasks = (this.sqlite.database.prepare(`
              SELECT tasks.* FROM tasks
              JOIN channels ON channels.id = tasks.channel_id
              WHERE tasks.repository_id = ?
                AND (channels.context_reset_at IS NULL OR tasks.created_at > channels.context_reset_at)
              ORDER BY tasks.queued_at
            `).all(repository.id) as unknown as TaskRow[])
              .map(mapTask)
            return { ...repository, channels, tasks }
          })
        const agents = (this.sqlite.database.prepare('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at').all(workspace.id) as unknown as AgentRow[])
          .map(mapAgent)
        const recentMessages = (this.sqlite.database.prepare(`
          SELECT messages.* FROM messages
          JOIN channels ON channels.id = messages.channel_id
          JOIN repositories ON repositories.id = channels.repository_id
          WHERE repositories.workspace_id = ?
            AND messages.deleted_at IS NULL
            AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
          ORDER BY messages.created_at DESC, messages.rowid DESC LIMIT 50
        `).all(workspace.id) as unknown as MessageRow[])
          .map(mapMessage)
          .reverse()
        return { ...workspace, agents, repositories, recentMessages }
      }),
    }
  }
}

function canRecoverExpiredTask(status: TaskStatus): boolean {
  return status === 'claimed' || status === 'running' || status === 'waiting_input'
}

function readTask(database: DatabaseSync, taskId: string): Task | undefined {
  const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  return row ? mapTask(row) : undefined
}

function readMessage(database: DatabaseSync, messageId: string): Message | undefined {
  const row = database.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined
  return row ? mapMessage(row) : undefined
}

function readChannel(database: DatabaseSync, channelId: string): Channel | undefined {
  const row = database.prepare('SELECT id, repository_id, name, system_key, archived_at, context_reset_at, created_at FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined
  return row ? mapChannel(database, row) : undefined
}

function readAgent(database: DatabaseSync, agentId: string): Agent | undefined {
  const row = database.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined
  return row ? mapAgent(row) : undefined
}

function readLease(database: DatabaseSync, leaseId: string): TaskLease | undefined {
  const row = database.prepare('SELECT * FROM task_leases WHERE id = ?').get(leaseId) as TaskLeaseRow | undefined
  return row ? mapTaskLease(row) : undefined
}

function readLeaseForTaskAgent(database: DatabaseSync, taskId: string, agentId: string): TaskLease | undefined {
  const row = database.prepare('SELECT * FROM task_leases WHERE task_id = ? AND agent_id = ?').get(taskId, agentId) as TaskLeaseRow | undefined
  return row ? mapTaskLease(row) : undefined
}

function hasActiveLease(database: DatabaseSync, agentId: string): boolean {
  return database.prepare('SELECT 1 FROM task_leases WHERE agent_id = ? LIMIT 1').get(agentId) !== undefined
}

function labelsMatch(capabilityTags: string[], labels: string[]): boolean {
  const capabilities = new Set(capabilityTags)
  return labels.every((label) => capabilities.has(label))
}

function oldestWorkspaceId(database: DatabaseSync): string | undefined {
  return (database.prepare('SELECT id FROM workspaces ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined)?.id
}

function oldestRepositoryId(database: DatabaseSync): string | undefined {
  return (database.prepare('SELECT id FROM repositories ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined)?.id
}

function workspaceIdForRepository(database: DatabaseSync, repositoryId: string): string | undefined {
  return (database.prepare('SELECT workspace_id FROM repositories WHERE id = ?').get(repositoryId) as { workspace_id: string } | undefined)?.workspace_id
}

function isGlobalAgentMentionConstraint(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('UNIQUE constraint failed')
    && (error.message.includes('agents_mention_name_unique_idx') || error.message.includes('agents.mention_name'))
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, leaseTtlMs: row.lease_ttl_ms, createdAt: row.created_at }
}

function mapRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    path: row.path,
    currentBranch: row.current_branch,
    defaultBranch: row.default_branch,
    isClean: row.is_clean === 1,
    createdAt: row.created_at,
  }
}

function mapChannel(database: DatabaseSync, row: ChannelRow): Channel {
  const memberAgentIds = row.system_key === summitSystemKey
    ? (database.prepare('SELECT id FROM agents ORDER BY created_at, id').all() as Array<{ id: string }>).map((agent) => agent.id)
    : (database.prepare('SELECT agent_id FROM channel_agent_memberships WHERE channel_id = ? ORDER BY agent_id').all(row.id) as Array<{ agent_id: string }>).map((membership) => membership.agent_id)
  const boundWorkspaceIds = (database.prepare(
    'SELECT workspace_id FROM channel_workspace_bindings WHERE channel_id = ? ORDER BY workspace_id',
  ).all(row.id) as Array<{ workspace_id: string }>).map((binding) => binding.workspace_id)
  return {
    id: row.id,
    name: row.name,
    systemKey: row.system_key,
    memberAgentIds,
    boundWorkspaceIds,
    subscriberAgentIds: memberAgentIds,
    archivedAt: row.archived_at,
    contextResetAt: row.context_reset_at,
    createdAt: row.created_at,
  }
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    channelId: row.channel_id,
    threadRootMessageId: row.thread_root_message_id,
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
    leaseTtlMs: row.lease_ttl_ms,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function resolveLeaseTtlMs(database: DatabaseSync, task: Task): number {
  if (task.leaseTtlMs !== null) return task.leaseTtlMs
  const row = database.prepare(`
    SELECT workspaces.lease_ttl_ms
    FROM repositories
    JOIN workspaces ON workspaces.id = repositories.workspace_id
    WHERE repositories.id = ?
  `).get(task.repositoryId) as { lease_ttl_ms: number } | undefined
  if (!row) throw new Error(`Repository ${task.repositoryId} does not have a workspace lease policy.`)
  return row.lease_ttl_ms
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  return value
}

function mapTaskInput(row: TaskInputRow): TaskInput {
  return { id: row.id, taskId: row.task_id, body: row.body, createdAt: row.created_at, consumedAt: row.consumed_at }
}

function mapTaskSession(row: TaskSessionRow): TaskSession {
  return {
    id: row.id, taskId: row.task_id, agentId: row.agent_id, runtimeSessionId: row.runtime_session_id,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function mapTaskLease(row: TaskLeaseRow): TaskLease {
  return { id: row.id, taskId: row.task_id, agentId: row.agent_id, expiresAt: row.expires_at, createdAt: row.created_at }
}

function mapTaskArtifact(row: TaskArtifactRow): TaskArtifact {
  return { id: row.id, taskId: row.task_id, kind: row.kind, path: row.path, createdAt: row.created_at }
}

function mapTaskEvent(row: TaskEventRow): TaskEventRecord {
  return { id: row.id, taskId: row.task_id, type: row.type, payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at }
}

function mapReviewDecision(row: ReviewDecisionRow): ReviewDecision {
  return { id: row.id, taskId: row.task_id, decision: row.decision, reason: row.reason, createdAt: row.created_at }
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadRootMessageId: row.thread_root_id,
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
    identity: row.identity,
    mentionName: row.mention_name,
    runtime: row.runtime,
    status: row.status,
    capabilityTags: JSON.parse(row.capability_tags_json) as string[],
    responsibilities: JSON.parse(row.responsibilities_json ?? '[]') as string[],
    maxConcurrentTasks: row.max_concurrent_tasks,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    model: row.model,
    env: JSON.parse(row.env_json) as Record<string, string>,
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
