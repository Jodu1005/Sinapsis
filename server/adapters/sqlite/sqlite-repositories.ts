import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Agent, AgentStatus, CreateAgentInput } from '../../domain/agent'
import type {
  AgentInvocation,
  ConversationHandoff,
  ConversationHandoffPatch,
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
} from '../../domain/conversation'
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

interface ConversationTurnRow {
  id: string
  channel_id: string
  trigger_message_id: string
  thread_root_message_id: string | null
  mode: ConversationTurn['mode']
  status: ConversationTurn['status']
  current_round: number
  max_rounds: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface TurnParticipantRow {
  id: string
  turn_id: string
  agent_id: string
  source: TurnParticipant['source']
  rank: number
  matcher_score: number | null
  decision: TurnParticipant['decision']
  confidence: number | null
  proposed_angle: string | null
  depends_on_agent_id: string | null
  speaking_order: number | null
  status: TurnParticipant['status']
  reason: string | null
  created_at: string
  updated_at: string
}

interface AgentInvocationRow {
  id: string
  turn_id: string
  agent_id: string
  kind: AgentInvocation['kind']
  priority: AgentInvocation['priority']
  round: number
  status: AgentInvocation['status']
  idempotency_key: string
  source_invocation_id: string | null
  sequence: number
  queued_at: string
  started_at: string | null
  completed_at: string | null
  error_code: string | null
}

interface ConversationHandoffRow {
  id: string
  turn_id: string
  source_invocation_id: string
  from_agent_id: string
  requested_target_agent_id: string
  to_agent_id: string | null
  question: string
  round: number
  status: ConversationHandoff['status']
  reason: string | null
  created_at: string
  updated_at: string
}

interface ConversationSessionRow {
  id: string
  key: string
  channel_id: string
  thread_root_message_id: string | null
  agent_id: string
  runtime: ConversationSession['runtime']
  runtime_session_id: string | null
  runtime_session_file: string | null
  status: ConversationSession['status']
  last_message_id: string | null
  last_used_at: string
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

  createConversationTurn(input: CreateConversationTurnInput): ConversationTurn {
    const createdAt = now()
    const turn: ConversationTurn = {
      id: randomUUID(),
      channelId: input.channelId,
      triggerMessageId: input.triggerMessageId,
      threadRootMessageId: input.threadRootMessageId,
      mode: input.mode,
      status: 'screening',
      currentRound: 0,
      maxRounds: input.maxRounds,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    }
    this.database.prepare(`
      INSERT INTO conversation_turns (
        id, channel_id, trigger_message_id, thread_root_message_id, mode, status,
        current_round, max_rounds, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id, turn.channelId, turn.triggerMessageId, turn.threadRootMessageId, turn.mode, turn.status,
      turn.currentRound, turn.maxRounds, turn.createdAt, turn.updatedAt, turn.completedAt,
    )
    return turn
  }

  createTurnParticipant(input: CreateTurnParticipantInput): TurnParticipant {
    const createdAt = now()
    const participant: TurnParticipant = {
      id: randomUUID(),
      turnId: input.turnId,
      agentId: input.agentId,
      source: input.source,
      rank: input.rank,
      matcherScore: input.matcherScore,
      decision: input.decision ?? 'pending',
      confidence: input.confidence ?? null,
      proposedAngle: input.proposedAngle ?? null,
      dependsOnAgentId: input.dependsOnAgentId ?? null,
      speakingOrder: input.speakingOrder ?? null,
      status: input.status ?? 'candidate',
      reason: input.reason ?? null,
      createdAt,
      updatedAt: createdAt,
    }
    this.database.prepare(`
      INSERT INTO turn_participants (
        id, turn_id, agent_id, source, rank, matcher_score, decision, confidence,
        proposed_angle, depends_on_agent_id, speaking_order, status, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      participant.id, participant.turnId, participant.agentId, participant.source, participant.rank,
      participant.matcherScore, participant.decision, participant.confidence, participant.proposedAngle,
      participant.dependsOnAgentId, participant.speakingOrder, participant.status, participant.reason,
      participant.createdAt, participant.updatedAt,
    )
    return participant
  }

  createAgentInvocation(input: CreateAgentInvocationInput): AgentInvocation {
    const queuedAt = now()
    const invocation: AgentInvocation = {
      id: randomUUID(),
      turnId: input.turnId,
      agentId: input.agentId,
      kind: input.kind,
      priority: input.priority,
      round: input.round,
      status: input.status ?? 'queued',
      idempotencyKey: input.idempotencyKey,
      sourceInvocationId: input.sourceInvocationId,
      queuedAt,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      errorCode: input.errorCode ?? null,
    }
    const sequence = (this.database.prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM agent_invocations
      WHERE turn_id = ?
    `).get(invocation.turnId) as { sequence: number }).sequence
    this.database.prepare(`
      INSERT INTO agent_invocations (
        id, turn_id, agent_id, kind, priority, round, status, idempotency_key,
        source_invocation_id, sequence, queued_at, started_at, completed_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invocation.id, invocation.turnId, invocation.agentId, invocation.kind, invocation.priority,
      invocation.round, invocation.status, invocation.idempotencyKey, invocation.sourceInvocationId,
      sequence, invocation.queuedAt, invocation.startedAt, invocation.completedAt, invocation.errorCode,
    )
    return invocation
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
    private readonly maxWorkspaceBindingsPerChannel = 5,
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

  createConversationTurn(input: CreateConversationTurnInput): ConversationTurn {
    return this.inTransaction((unitOfWork) => unitOfWork.createConversationTurn(input))
  }

  createTurnParticipant(input: CreateTurnParticipantInput): TurnParticipant {
    return this.inTransaction((unitOfWork) => unitOfWork.createTurnParticipant(input))
  }

  createAgentInvocation(input: CreateAgentInvocationInput): AgentInvocation {
    return this.inTransaction((unitOfWork) => unitOfWork.createAgentInvocation(input))
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

  getConversationTurn(turnId: string): ConversationTurn | undefined {
    return readConversationTurn(this.sqlite.database, turnId)
  }

  getConversationTurnDetails(turnId: string) {
    const turn = this.getConversationTurn(turnId)
    if (!turn) return undefined
    return {
      turn,
      participants: this.listTurnParticipants(turnId),
      invocations: this.listAgentInvocations(turnId),
      handoffs: this.listConversationHandoffs(turnId),
    }
  }

  listActiveConversationTurns(channelId?: string): ConversationTurn[] {
    const terminalStatuses = "'completed', 'partial', 'cancelled', 'failed'"
    const rows = channelId === undefined
      ? this.sqlite.database.prepare(`
          SELECT * FROM conversation_turns
          WHERE status NOT IN (${terminalStatuses})
          ORDER BY created_at, id
        `).all()
      : this.sqlite.database.prepare(`
          SELECT * FROM conversation_turns
          WHERE channel_id = ? AND status NOT IN (${terminalStatuses})
          ORDER BY created_at, id
        `).all(channelId)
    return (rows as unknown as ConversationTurnRow[]).map(mapConversationTurn)
  }

  updateConversationTurn(turnId: string, patch: ConversationTurnPatch): ConversationTurn {
    return this.inTransaction(() => {
      const turn = readConversationTurn(this.sqlite.database, turnId)
      if (!turn) throw new Error(`Conversation turn ${turnId} does not exist.`)
      const updated: ConversationTurn = {
        ...turn,
        mode: patch.mode ?? turn.mode,
        status: patch.status ?? turn.status,
        currentRound: patch.currentRound ?? turn.currentRound,
        maxRounds: patch.maxRounds ?? turn.maxRounds,
        completedAt: patch.completedAt === undefined ? turn.completedAt : patch.completedAt,
        updatedAt: now(),
      }
      this.sqlite.database.prepare(`
        UPDATE conversation_turns
        SET mode = ?, status = ?, current_round = ?, max_rounds = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        updated.mode, updated.status, updated.currentRound, updated.maxRounds,
        updated.completedAt, updated.updatedAt, updated.id,
      )
      return updated
    })
  }

  updateTurnParticipant(turnId: string, agentId: string, patch: ParticipantPatch): TurnParticipant {
    return this.inTransaction(() => {
      const row = this.sqlite.database.prepare(`
        SELECT * FROM turn_participants WHERE turn_id = ? AND agent_id = ?
      `).get(turnId, agentId) as TurnParticipantRow | undefined
      if (!row) throw new Error(`Turn participant ${turnId}/${agentId} does not exist.`)
      const participant = mapTurnParticipant(row)
      const updated: TurnParticipant = {
        ...participant,
        source: patch.source ?? participant.source,
        rank: patch.rank ?? participant.rank,
        matcherScore: patch.matcherScore === undefined ? participant.matcherScore : patch.matcherScore,
        decision: patch.decision ?? participant.decision,
        confidence: patch.confidence === undefined ? participant.confidence : patch.confidence,
        proposedAngle: patch.proposedAngle === undefined ? participant.proposedAngle : patch.proposedAngle,
        dependsOnAgentId: patch.dependsOnAgentId === undefined ? participant.dependsOnAgentId : patch.dependsOnAgentId,
        speakingOrder: patch.speakingOrder === undefined ? participant.speakingOrder : patch.speakingOrder,
        status: patch.status ?? participant.status,
        reason: patch.reason === undefined ? participant.reason : patch.reason,
        updatedAt: now(),
      }
      this.sqlite.database.prepare(`
        UPDATE turn_participants
        SET source = ?, rank = ?, matcher_score = ?, decision = ?, confidence = ?, proposed_angle = ?,
          depends_on_agent_id = ?, speaking_order = ?, status = ?, reason = ?, updated_at = ?
        WHERE turn_id = ? AND agent_id = ?
      `).run(
        updated.source, updated.rank, updated.matcherScore, updated.decision, updated.confidence,
        updated.proposedAngle, updated.dependsOnAgentId, updated.speakingOrder, updated.status,
        updated.reason, updated.updatedAt, turnId, agentId,
      )
      return updated
    })
  }

  listTurnParticipants(turnId: string): TurnParticipant[] {
    return (this.sqlite.database.prepare(`
      SELECT * FROM turn_participants WHERE turn_id = ? ORDER BY rank, created_at, id
    `).all(turnId) as unknown as TurnParticipantRow[]).map(mapTurnParticipant)
  }

  updateAgentInvocation(invocationId: string, patch: InvocationPatch): AgentInvocation {
    return this.inTransaction(() => {
      const row = this.sqlite.database.prepare('SELECT * FROM agent_invocations WHERE id = ?')
        .get(invocationId) as AgentInvocationRow | undefined
      if (!row) throw new Error(`Agent invocation ${invocationId} does not exist.`)
      const invocation = mapAgentInvocation(row)
      const updated: AgentInvocation = {
        ...invocation,
        status: patch.status ?? invocation.status,
        startedAt: patch.startedAt === undefined ? invocation.startedAt : patch.startedAt,
        completedAt: patch.completedAt === undefined ? invocation.completedAt : patch.completedAt,
        errorCode: patch.errorCode === undefined ? invocation.errorCode : patch.errorCode,
      }
      this.sqlite.database.prepare(`
        UPDATE agent_invocations
        SET status = ?, started_at = ?, completed_at = ?, error_code = ?
        WHERE id = ?
      `).run(updated.status, updated.startedAt, updated.completedAt, updated.errorCode, updated.id)
      return updated
    })
  }

  listAgentInvocations(turnId: string): AgentInvocation[] {
    return (this.sqlite.database.prepare(`
      SELECT * FROM agent_invocations WHERE turn_id = ? ORDER BY sequence
    `).all(turnId) as unknown as AgentInvocationRow[]).map(mapAgentInvocation)
  }

  createConversationHandoff(input: CreateConversationHandoffInput): ConversationHandoff {
    return this.inTransaction(() => {
      const handoff: ConversationHandoff = {
        id: randomUUID(),
        turnId: input.turnId,
        sourceInvocationId: input.sourceInvocationId,
        fromAgentId: input.fromAgentId,
        requestedTargetAgentId: input.requestedTargetAgentId,
        toAgentId: input.toAgentId,
        question: input.question,
        round: input.round,
        status: input.status ?? 'queued',
        reason: input.reason ?? null,
        createdAt: now(),
        updatedAt: now(),
      }
      this.sqlite.database.prepare(`
        INSERT INTO conversation_handoffs (
          id, turn_id, source_invocation_id, from_agent_id, requested_target_agent_id, to_agent_id,
          question, round, status, reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        handoff.id, handoff.turnId, handoff.sourceInvocationId, handoff.fromAgentId,
        handoff.requestedTargetAgentId, handoff.toAgentId, handoff.question, handoff.round,
        handoff.status, handoff.reason, handoff.createdAt, handoff.updatedAt,
      )
      return handoff
    })
  }

  updateConversationHandoff(handoffId: string, patch: ConversationHandoffPatch): ConversationHandoff {
    return this.inTransaction(() => {
      const row = this.sqlite.database.prepare('SELECT * FROM conversation_handoffs WHERE id = ?')
        .get(handoffId) as ConversationHandoffRow | undefined
      if (!row) throw new Error(`Conversation handoff ${handoffId} does not exist.`)
      const handoff = mapConversationHandoff(row)
      const updated: ConversationHandoff = {
        ...handoff,
        status: patch.status ?? handoff.status,
        reason: patch.reason === undefined ? handoff.reason : patch.reason,
        updatedAt: now(),
      }
      this.sqlite.database.prepare(`
        UPDATE conversation_handoffs SET status = ?, reason = ?, updated_at = ? WHERE id = ?
      `).run(updated.status, updated.reason, updated.updatedAt, updated.id)
      return updated
    })
  }

  listConversationHandoffs(turnId: string): ConversationHandoff[] {
    return (this.sqlite.database.prepare(`
      SELECT * FROM conversation_handoffs WHERE turn_id = ? ORDER BY created_at, rowid
    `).all(turnId) as unknown as ConversationHandoffRow[]).map(mapConversationHandoff)
  }

  getConversationSession(key: string): ConversationSession | undefined {
    const row = this.sqlite.database.prepare('SELECT * FROM conversation_sessions WHERE key = ?')
      .get(key) as ConversationSessionRow | undefined
    return row ? mapConversationSession(row) : undefined
  }

  upsertConversationSession(input: UpsertConversationSessionInput): ConversationSession {
    return this.inTransaction(() => {
      const existing = this.getConversationSession(input.key)
      if (existing && (
        existing.channelId !== input.channelId
        || (existing.threadRootMessageId ?? null) !== (input.threadRootMessageId ?? null)
        || existing.agentId !== input.agentId
      )) {
        throw new Error(`Conversation session ${input.key} identity cannot change.`)
      }
      const updatedAt = now()
      const session: ConversationSession = {
        id: existing?.id ?? randomUUID(),
        ...input,
        lastUsedAt: updatedAt,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      }
      this.sqlite.database.prepare(`
        INSERT INTO conversation_sessions (
          id, key, channel_id, thread_root_message_id, agent_id, runtime,
          runtime_session_id, runtime_session_file, status, last_message_id,
          last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          runtime = excluded.runtime,
          runtime_session_id = excluded.runtime_session_id,
          runtime_session_file = excluded.runtime_session_file,
          status = excluded.status,
          last_message_id = excluded.last_message_id,
          last_used_at = excluded.last_used_at,
          updated_at = excluded.updated_at
      `).run(
        session.id, session.key, session.channelId, session.threadRootMessageId, session.agentId,
        session.runtime, session.runtimeSessionId, session.runtimeSessionFile, session.status,
        session.lastMessageId, session.lastUsedAt, session.createdAt, session.updatedAt,
      )
      return session
    })
  }

  listMessagesForConversation(channelId: string, threadRootMessageId: string | null): Message[] {
    const database = this.sqlite.database
    const rows = threadRootMessageId === null
      ? database.prepare(`
          SELECT messages.*
          FROM messages
          JOIN channels ON channels.id = messages.channel_id
          WHERE messages.channel_id = ?
            AND messages.thread_root_id IS NULL
            AND messages.deleted_at IS NULL
            AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
          ORDER BY messages.created_at, messages.rowid
        `).all(channelId)
      : database.prepare(`
          SELECT messages.*
          FROM messages
          JOIN channels ON channels.id = messages.channel_id
          WHERE messages.channel_id = ?
            AND (messages.id = ? OR messages.thread_root_id = ?)
            AND messages.deleted_at IS NULL
            AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
          ORDER BY messages.created_at, messages.rowid
        `).all(channelId, threadRootMessageId, threadRootMessageId)
    return (rows as unknown as MessageRow[]).map(mapMessage)
  }

  getLastAgentSpokenAt(channelId: string, agentId: string): string | null {
    const row = this.sqlite.database.prepare(`
      SELECT messages.created_at
      FROM messages
      JOIN channels ON channels.id = messages.channel_id
      WHERE messages.channel_id = ?
        AND messages.sender_type = 'agent'
        AND messages.sender_id = ?
        AND messages.deleted_at IS NULL
        AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
      ORDER BY messages.created_at DESC, messages.rowid DESC
      LIMIT 1
    `).get(channelId, agentId) as { created_at: string } | undefined
    return row?.created_at ?? null
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
          SELECT tasks.* FROM tasks
          JOIN channels ON channels.id = tasks.channel_id
          WHERE tasks.status = 'queued' AND (tasks.direct_agent_id IS NULL OR tasks.direct_agent_id = ?)
          AND (
            channels.system_key = ?
            OR EXISTS (
              SELECT 1 FROM channel_agent_memberships
              WHERE channel_agent_memberships.channel_id = tasks.channel_id
                AND channel_agent_memberships.agent_id = ?
            )
          )
          ORDER BY tasks.queued_at ASC, tasks.rowid ASC
        `).all(agentId, summitSystemKey, agentId) as unknown as TaskRow[]).map(mapTask)
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
    const database = this.sqlite.database
    const workspaceRows = database.prepare('SELECT id, name, lease_ttl_ms, created_at FROM workspaces ORDER BY created_at').all() as unknown as WorkspaceRow[]
    const repositoryRows = database.prepare(
      'SELECT id, workspace_id, name, path, current_branch, default_branch, is_clean, created_at FROM repositories ORDER BY created_at, id',
    ).all() as unknown as RepositoryRow[]
    const agents = this.listAgents()
    const channelRows = database.prepare(`
      SELECT id, repository_id, name, system_key, archived_at, context_reset_at, created_at
      FROM channels ORDER BY archived_at IS NOT NULL, created_at, id
    `).all() as unknown as ChannelRow[]
    const membershipRows = database.prepare(
      'SELECT channel_id, agent_id FROM channel_agent_memberships ORDER BY channel_id, agent_id',
    ).all() as Array<{ channel_id: string; agent_id: string }>
    const bindingRows = database.prepare(
      'SELECT channel_id, workspace_id FROM channel_workspace_bindings ORDER BY channel_id, workspace_id',
    ).all() as Array<{ channel_id: string; workspace_id: string }>
    const memberships = groupRelationshipRows(membershipRows, 'agent_id')
    const bindings = groupRelationshipRows(bindingRows, 'workspace_id')
    const globalAgentIds = agents.map((agent) => agent.id)
    const channels = channelRows.map((row): Channel => {
      const memberAgentIds = row.system_key === summitSystemKey
        ? globalAgentIds
        : memberships.get(row.id) ?? []
      return {
        id: row.id,
        name: row.name,
        systemKey: row.system_key,
        memberAgentIds,
        boundWorkspaceIds: bindings.get(row.id) ?? [],
        subscriberAgentIds: memberAgentIds,
        archivedAt: row.archived_at,
        contextResetAt: row.context_reset_at,
        createdAt: row.created_at,
      }
    })
    const tasks = (database.prepare(`
      SELECT tasks.* FROM tasks
      JOIN channels ON channels.id = tasks.channel_id
      WHERE channels.context_reset_at IS NULL OR tasks.created_at > channels.context_reset_at
      ORDER BY tasks.queued_at, tasks.rowid
    `).all() as unknown as TaskRow[]).map(mapTask)
    const recentMessages = (database.prepare(`
      SELECT ranked.* FROM (
        SELECT
          messages.*,
          messages.rowid AS message_rowid,
          ROW_NUMBER() OVER (
            PARTITION BY messages.channel_id
            ORDER BY messages.created_at DESC, messages.rowid DESC
          ) AS channel_rank
        FROM messages
        JOIN channels ON channels.id = messages.channel_id
        WHERE messages.deleted_at IS NULL
          AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
      ) AS ranked
      WHERE ranked.channel_rank <= 50
      ORDER BY ranked.created_at, ranked.message_rowid
    `).all() as unknown as MessageRow[]).map(mapMessage)
    const repositoriesByWorkspace = new Map<string, Repository[]>()
    for (const row of repositoryRows) {
      const repositories = repositoriesByWorkspace.get(row.workspace_id) ?? []
      repositories.push(mapRepository(row))
      repositoriesByWorkspace.set(row.workspace_id, repositories)
    }
    return {
      agents,
      channels,
      workspaces: workspaceRows.map((row) => {
        const workspace = mapWorkspace(row)
        return { ...workspace, repositories: repositoriesByWorkspace.get(workspace.id) ?? [] }
      }),
      tasks,
      recentMessages,
      maxWorkspaceBindingsPerChannel: this.maxWorkspaceBindingsPerChannel,
    }
  }
}

function groupRelationshipRows<Key extends 'agent_id' | 'workspace_id'>(
  rows: Array<{ channel_id: string } & Record<Key, string>>,
  key: Key,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    const values = grouped.get(row.channel_id) ?? []
    values.push(row[key])
    grouped.set(row.channel_id, values)
  }
  return grouped
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

function readConversationTurn(database: DatabaseSync, turnId: string): ConversationTurn | undefined {
  const row = database.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(turnId) as ConversationTurnRow | undefined
  return row ? mapConversationTurn(row) : undefined
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

function mapConversationTurn(row: ConversationTurnRow): ConversationTurn {
  return {
    id: row.id,
    channelId: row.channel_id,
    triggerMessageId: row.trigger_message_id,
    threadRootMessageId: row.thread_root_message_id,
    mode: row.mode,
    status: row.status,
    currentRound: row.current_round,
    maxRounds: row.max_rounds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function mapTurnParticipant(row: TurnParticipantRow): TurnParticipant {
  return {
    id: row.id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    source: row.source,
    rank: row.rank,
    matcherScore: row.matcher_score,
    decision: row.decision,
    confidence: row.confidence,
    proposedAngle: row.proposed_angle,
    dependsOnAgentId: row.depends_on_agent_id,
    speakingOrder: row.speaking_order,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAgentInvocation(row: AgentInvocationRow): AgentInvocation {
  return {
    id: row.id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    kind: row.kind,
    priority: row.priority,
    round: row.round,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    sourceInvocationId: row.source_invocation_id,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
  }
}

function mapConversationHandoff(row: ConversationHandoffRow): ConversationHandoff {
  return {
    id: row.id,
    turnId: row.turn_id,
    sourceInvocationId: row.source_invocation_id,
    fromAgentId: row.from_agent_id,
    requestedTargetAgentId: row.requested_target_agent_id,
    toAgentId: row.to_agent_id,
    question: row.question,
    round: row.round,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapConversationSession(row: ConversationSessionRow): ConversationSession {
  return {
    id: row.id,
    key: row.key,
    channelId: row.channel_id,
    threadRootMessageId: row.thread_root_message_id,
    agentId: row.agent_id,
    runtime: row.runtime,
    runtimeSessionId: row.runtime_session_id,
    runtimeSessionFile: row.runtime_session_file,
    status: row.status,
    lastMessageId: row.last_message_id,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
