import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Agent, AgentStatus, CreateAgentInput } from '../../domain/agent'
import type { DomainEvent } from '../../domain/events'
import type { CreateMessageInput, Message, MessageSenderType } from '../../domain/message'
import {
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
  current_branch: string
  default_branch: string
  is_clean: number
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
  runtime: 'opencode' | 'pi'
  status: Agent['status']
  capability_tags_json: string
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

  createAgent(input: CreateAgentInput): Agent {
    const createdAt = now()
    const agent: Agent = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      identity: requireText(input.identity, 'Agent identity'),
      mentionName: requireText(input.mentionName, 'Agent mention'),
      runtime: input.runtime,
      status: 'offline',
      capabilityTags: input.capabilityTags,
      maxConcurrentTasks: input.maxConcurrentTasks,
      command: requireText(input.command, 'Runtime command'),
      args: input.args,
      model: input.model,
      env: input.env,
      createdAt,
      updatedAt: createdAt,
    }
    this.database.prepare(`
      INSERT INTO agents (
        id, workspace_id, identity, mention_name, runtime, status, capability_tags_json,
        max_concurrent_tasks, command, args_json, model, env_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id, agent.workspaceId, agent.identity, agent.mentionName, agent.runtime, agent.status,
      JSON.stringify(agent.capabilityTags), agent.maxConcurrentTasks, agent.command, JSON.stringify(agent.args),
      agent.model, JSON.stringify(agent.env), agent.createdAt, agent.updatedAt,
    )
    return agent
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

  createChannel(input: CreateChannelInput): Channel {
    return this.inTransaction((unitOfWork) => unitOfWork.createChannel(input))
  }

  createAgent(input: CreateAgentInput): Agent {
    return this.inTransaction((unitOfWork) => unitOfWork.createAgent(input))
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

  getTask(taskId: string): Task | undefined {
    return readTask(this.sqlite.database, taskId)
  }

  getTasksForRepository(repositoryId: string): Task[] {
    return (this.sqlite.database.prepare('SELECT * FROM tasks WHERE repository_id = ? ORDER BY queued_at').all(repositoryId) as unknown as TaskRow[])
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

  hasAgentMention(workspaceId: string, mentionName: string): boolean {
    const row = this.sqlite.database.prepare(
      'SELECT 1 FROM agents WHERE workspace_id = ? AND mention_name = ? LIMIT 1',
    ).get(workspaceId, mentionName)
    return row !== undefined
  }

  getIdleAgentIds(): string[] {
    return (this.sqlite.database.prepare('SELECT id FROM agents WHERE status = ? ORDER BY updated_at, id').all('idle') as Array<{ id: string }>)
      .map((agent) => agent.id)
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

  claimNextTask(agentId: string, occurredAt: Date, leaseTtlMs: number): TaskClaim | undefined {
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) throw new Error('Lease TTL must be a positive integer.')

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
        candidate = candidates.find((task) => labelsMatch(agent.capabilityTags, task.labels))
        if (!candidate) return undefined

        const taskUpdate = database.prepare(`
          UPDATE tasks SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'queued'
        `).run(occurredAtIso, candidate.id)
        if (Number(taskUpdate.changes) === 1) break
      }

      const lease: TaskLease = {
        id: randomUUID(), taskId: candidate.id, agentId,
        expiresAt: new Date(occurredAt.getTime() + leaseTtlMs).toISOString(), createdAt: occurredAtIso,
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

  renewTaskLease(taskId: string, agentId: string, occurredAt: Date, leaseTtlMs: number): TaskLease | undefined {
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) throw new Error('Lease TTL must be a positive integer.')

    return this.inTransaction((unitOfWork) => {
      const database = this.sqlite.database
      const lease = readLeaseForTaskAgent(database, taskId, agentId)
      if (!lease) return undefined
      const expiresAt = new Date(occurredAt.getTime() + leaseTtlMs).toISOString()
      const updated = database.prepare(`
        UPDATE task_leases SET expires_at = ? WHERE id = ? AND expires_at > ?
      `).run(expiresAt, lease.id, occurredAt.toISOString())
      if (Number(updated.changes) !== 1) return undefined
      unitOfWork.recordTaskEvent(taskId, 'task.lease_renewed', { agentId, leaseId: lease.id, expiresAt })
      return { ...lease, expiresAt }
    })
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
      if (!task || !canRecoverExpiredTask(task.status)) return undefined

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

  getBootstrap(): BootstrapSnapshot {
    const workspaces = this.sqlite.database.prepare('SELECT id, name, created_at FROM workspaces ORDER BY created_at').all() as unknown as WorkspaceRow[]
    return {
      workspaces: workspaces.map((workspaceRow) => {
        const workspace = mapWorkspace(workspaceRow)
        const repositories = (this.sqlite.database.prepare('SELECT id, workspace_id, name, path, current_branch, default_branch, is_clean, created_at FROM repositories WHERE workspace_id = ? ORDER BY created_at').all(workspace.id) as unknown as RepositoryRow[])
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

function mapWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, createdAt: row.created_at }
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
    identity: row.identity,
    mentionName: row.mention_name,
    runtime: row.runtime,
    status: row.status,
    capabilityTags: JSON.parse(row.capability_tags_json) as string[],
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
