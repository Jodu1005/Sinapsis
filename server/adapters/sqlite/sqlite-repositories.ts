import { createHash, randomUUID } from 'node:crypto'
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
import type {
  CreateDreamRunInput,
  CreateMemoryCandidateInput,
  CreateMemoryFromCandidateInput,
  DreamRun,
  DreamRunFilter,
  DreamRunPatch,
  DreamWatermark,
  MemoryCandidate,
  MemoryCandidateFilter,
  MemoryCandidateSourceMetadata,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  ReviewMemoryCandidateInput,
  ThreadSummary,
  UpsertThreadSummaryInput,
} from '../../domain/memory'
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
  ActiveConversationTurnProjection,
  CancelConversationTurnInput,
  CancelConversationTurnResult,
  ConversationTurnClaimResult,
  ExpiredLease,
  LeaseRecovery,
  TaskClaim,
  SettleConversationInvocationInput,
  SettleConversationInvocationResult,
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

interface DreamRunRow {
  id: string
  scope: 'channel'
  scope_id: string
  trigger: DreamRun['trigger']
  status: DreamRun['status']
  from_message_created_at: string | null
  from_message_id: string | null
  to_message_created_at: string | null
  to_message_id: string | null
  candidate_count: number
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

interface MemoryCandidateRow {
  id: string
  dream_run_id: string
  proposed_scope: MemoryScope
  channel_id: string | null
  kind: MemoryKind
  proposed_content: string
  rationale: string
  confidence: number
  importance: number
  content_hash: string
  status: MemoryCandidate['status']
  reviewed_content: string | null
  reviewed_scope: MemoryScope | null
  reviewed_channel_id: string | null
  reviewed_at: string | null
  created_at: string
}

interface MemoryRow {
  id: string
  scope: MemoryScope
  channel_id: string | null
  kind: MemoryKind
  content: string
  content_hash: string
  status: MemoryRecord['status']
  source_candidate_id: string
  archived_at: string | null
  created_at: string
  updated_at: string
  source_confidence?: number
  source_importance?: number
}

interface ThreadSummaryRow {
  channel_id: string
  thread_root_message_id: string
  content: string
  through_message_created_at: string | null
  through_message_id: string | null
  created_at: string
  updated_at: string
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
  recovery_owner_id: string | null
  recovery_claimed_at: string | null
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
  result_json: string | null
}

interface ActiveConversationTurnRow extends ConversationTurnRow {
  invocation_id: string | null
  invocation_agent_id: string | null
  invocation_kind: AgentInvocation['kind'] | null
  invocation_priority: AgentInvocation['priority'] | null
  invocation_round: number | null
  invocation_status: AgentInvocation['status'] | null
  invocation_idempotency_key: string | null
  invocation_source_id: string | null
  invocation_sequence: number | null
  invocation_queued_at: string | null
  invocation_started_at: string | null
  invocation_completed_at: string | null
  invocation_error_code: string | null
  invocation_result_json: string | null
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
      resultJson: input.resultJson ?? null,
    }
    const sequence = (this.database.prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM agent_invocations
      WHERE turn_id = ?
    `).get(invocation.turnId) as { sequence: number }).sequence
    this.database.prepare(`
      INSERT INTO agent_invocations (
        id, turn_id, agent_id, kind, priority, round, status, idempotency_key,
        source_invocation_id, sequence, queued_at, started_at, completed_at, error_code, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invocation.id, invocation.turnId, invocation.agentId, invocation.kind, invocation.priority,
      invocation.round, invocation.status, invocation.idempotencyKey, invocation.sourceInvocationId,
      sequence, invocation.queuedAt, invocation.startedAt, invocation.completedAt, invocation.errorCode,
      invocation.resultJson,
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

  createClaimedConversationTurn(
    input: CreateConversationTurnInput,
    ownerId: string,
    occurredAt: Date,
  ): ConversationTurn {
    return this.inTransaction((unitOfWork) => {
      const turn = unitOfWork.createConversationTurn(input)
      const occurredAtIso = occurredAt.toISOString()
      this.sqlite.database.prepare(`
        UPDATE conversation_turns
        SET recovery_owner_id = ?, recovery_claimed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(ownerId, occurredAtIso, occurredAtIso, turn.id)
      return { ...turn, updatedAt: occurredAtIso }
    })
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

  createDreamRun(input: CreateDreamRunInput): DreamRun {
    return this.inTransaction(() => {
      const database = this.sqlite.database
      if (!readChannel(database, input.scopeId)) throw new Error(`Channel ${input.scopeId} does not exist.`)
      assertDreamBoundary(database, input.scopeId, input.from)
      assertDreamBoundary(database, input.scopeId, input.to)
      const createdAt = now()
      const run: DreamRun = {
        id: randomUUID(), scope: input.scope, scopeId: input.scopeId, trigger: input.trigger, status: 'queued',
        fromMessageCreatedAt: input.from?.createdAt ?? null, fromMessageId: input.from?.id ?? null,
        toMessageCreatedAt: input.to?.createdAt ?? null, toMessageId: input.to?.id ?? null,
        candidateCount: 0, error: null, createdAt, startedAt: null, completedAt: null,
      }
      database.prepare(`
        INSERT INTO dream_runs (
          id, scope, scope_id, trigger, status, from_message_created_at, from_message_id,
          to_message_created_at, to_message_id, candidate_count, error, created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id, run.scope, run.scopeId, run.trigger, run.status, run.fromMessageCreatedAt, run.fromMessageId,
        run.toMessageCreatedAt, run.toMessageId, run.candidateCount, run.error, run.createdAt, run.startedAt, run.completedAt,
      )
      for (const messageId of new Set([run.fromMessageId, run.toMessageId].filter((id): id is string => id !== null))) {
        database.prepare('INSERT INTO dream_run_sources (dream_run_id, message_id, turn_id) VALUES (?, ?, ?)').run(
          run.id, messageId, sourceTurnId(database, messageId),
        )
      }
      this.sqlite.afterCommit(() => this.publisher.publish(event('dream.run_created', 'dream_run', run.id, run.createdAt)))
      return run
    })
  }

  createIncrementalDreamRun(input: { channelId: string; trigger: DreamRun['trigger'] }): DreamRun {
    return this.inTransaction(() => {
      const database = this.sqlite.database
      const channel = readChannel(database, input.channelId)
      if (!channel) throw new Error(`Channel ${input.channelId} does not exist.`)
      if (channel.archivedAt) throw new Error(`Channel #${channel.name} is archived.`)

      const watermark = this.getDreamWatermark(input.channelId)
      const rows = database.prepare(`
        SELECT messages.id, messages.created_at
        FROM messages
        JOIN channels ON channels.id = messages.channel_id
        WHERE messages.channel_id = ?
          AND messages.deleted_at IS NULL
          AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
          AND NOT EXISTS (
            SELECT 1
            FROM dream_run_sources completed_sources
            JOIN dream_runs completed_runs ON completed_runs.id = completed_sources.dream_run_id
            WHERE completed_sources.message_id = messages.id
              AND completed_runs.scope_id = messages.channel_id
              AND completed_runs.status = 'completed'
          )
        ORDER BY messages.created_at, messages.id
      `).all(input.channelId) as Array<{ id: string; created_at: string }>
      const last = rows.at(-1)
      const to = last ? { createdAt: last.created_at, id: last.id } : watermark
        ? { createdAt: watermark.toMessageCreatedAt, id: watermark.toMessageId }
        : null
      const existingRow = database.prepare(`
        SELECT * FROM dream_runs
        WHERE scope_id = ?
          AND COALESCE(to_message_created_at, '') = COALESCE(?, '')
          AND COALESCE(to_message_id, '') = COALESCE(?, '')
        ORDER BY created_at, id
        LIMIT 1
      `).get(input.channelId, to?.createdAt ?? null, to?.id ?? null) as DreamRunRow | undefined
      if (existingRow) return mapDreamRun(existingRow)

      const run = this.createDreamRun({
        scope: 'channel', scopeId: input.channelId, trigger: input.trigger,
        from: watermark ? { createdAt: watermark.toMessageCreatedAt, id: watermark.toMessageId } : null,
        to,
      })
      database.prepare('DELETE FROM dream_run_sources WHERE dream_run_id = ?').run(run.id)
      const insertSource = database.prepare(
        'INSERT INTO dream_run_sources (dream_run_id, message_id, turn_id) VALUES (?, ?, ?)',
      )
      for (const row of rows) insertSource.run(run.id, row.id, sourceTurnId(database, row.id))
      return run
    })
  }

  updateDreamRun(runId: string, patch: DreamRunPatch): DreamRun {
    return this.inTransaction(() => {
      const existing = this.getDreamRun(runId)
      if (!existing) throw new Error(`Dream run ${runId} does not exist.`)
      const updated = { ...existing, ...patch }
      this.sqlite.database.prepare(`
        UPDATE dream_runs
        SET status = ?, candidate_count = ?, error = ?, started_at = ?, completed_at = ?
        WHERE id = ?
      `).run(updated.status, updated.candidateCount, updated.error, updated.startedAt, updated.completedAt, runId)
      this.sqlite.afterCommit(() => this.publisher.publish(event('dream.run_updated', 'dream_run', updated.id, now())))
      return updated
    })
  }

  getDreamRun(runId: string): DreamRun | undefined {
    const row = this.sqlite.database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(runId) as DreamRunRow | undefined
    return row ? mapDreamRun(row) : undefined
  }

  listDreamRuns(filter: DreamRunFilter = {}): DreamRun[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter.channelId !== undefined) {
      clauses.push('scope_id = ?')
      values.push(filter.channelId)
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      values.push(filter.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.sqlite.database.prepare(`SELECT * FROM dream_runs ${where} ORDER BY created_at, id`).all(...values) as unknown as DreamRunRow[])
      .map(mapDreamRun)
  }

  getDreamWatermark(channelId: string): DreamWatermark | undefined {
    const row = this.sqlite.database.prepare(`
      SELECT scope_id, to_message_created_at, to_message_id
      FROM dream_runs
      WHERE scope_id = ? AND status = 'completed' AND to_message_id IS NOT NULL
      ORDER BY to_message_created_at DESC, to_message_id DESC
      LIMIT 1
    `).get(channelId) as { scope_id: string; to_message_created_at: string; to_message_id: string } | undefined
    return row && {
      channelId: row.scope_id,
      toMessageCreatedAt: row.to_message_created_at,
      toMessageId: row.to_message_id,
    }
  }

  recoverDreamMemory(occurredAt: Date): { failedRunIds: string[]; invalidCandidateIds: string[] } {
    return this.inTransaction(() => {
      const database = this.sqlite.database
      const recoveredAt = occurredAt.toISOString()
      const failedRunIds = (database.prepare(`
        SELECT id FROM dream_runs WHERE status = 'running' ORDER BY created_at, id
      `).all() as Array<{ id: string }>).map((row) => row.id)
      database.prepare(`
        UPDATE dream_runs
        SET status = 'failed', error = 'service_restarted', completed_at = ?
        WHERE status = 'running'
      `).run(recoveredAt)

      const invalidCandidateIds = (database.prepare(`
        SELECT candidates.id
        FROM memory_candidates AS candidates
        JOIN dream_runs AS runs ON runs.id = candidates.dream_run_id
        WHERE candidates.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM memory_candidate_sources AS sources
            JOIN messages ON messages.id = sources.message_id
            WHERE sources.candidate_id = candidates.id
              AND messages.deleted_at IS NULL
              AND messages.channel_id = runs.scope_id
          )
        ORDER BY candidates.created_at, candidates.id
      `).all() as Array<{ id: string }>).map((row) => row.id)
      const quarantineCandidate = database.prepare(`
        UPDATE memory_candidates
        SET status = 'superseded', reviewed_at = ?
        WHERE id = ? AND status = 'pending'
      `)
      const recordAudit = database.prepare(`
        INSERT INTO dream_recovery_audit (
          id, entity_type, entity_id, error, created_at
        ) VALUES (?, 'memory_candidate', ?, 'invalid_candidate_sources', ?)
        ON CONFLICT(entity_type, entity_id, error)
        DO UPDATE SET created_at = excluded.created_at
      `)
      for (const candidateId of invalidCandidateIds) {
        quarantineCandidate.run(recoveredAt, candidateId)
        recordAudit.run(randomUUID(), candidateId, recoveredAt)
      }

      for (const runId of failedRunIds) {
        this.sqlite.afterCommit(() => this.publisher.publish(event('dream.run_updated', 'dream_run', runId, recoveredAt)))
      }
      for (const candidateId of invalidCandidateIds) {
        this.sqlite.afterCommit(() => this.publisher.publish(event(
          'memory.candidate_reviewed', 'memory_candidate', candidateId, recoveredAt,
        )))
      }
      return { failedRunIds, invalidCandidateIds }
    })
  }

  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate {
    return this.createMemoryCandidates([input])[0]!
  }

  createMemoryCandidates(inputs: CreateMemoryCandidateInput[]): MemoryCandidate[] {
    return this.inTransaction(() => {
      const candidateIds = new Set<string>()
      return inputs.map((input) => {
        const candidate = this.insertMemoryCandidate(input)
        if (candidateIds.has(candidate.id)) {
          throw new Error('UNIQUE constraint failed: memory_candidates_run_content_unique_idx')
        }
        candidateIds.add(candidate.id)
        return candidate
      })
    })
  }

  private insertMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate {
    const database = this.sqlite.database
    const run = this.getDreamRun(input.dreamRunId)
    if (!run) throw new Error(`Dream run ${input.dreamRunId} does not exist.`)
    assertMemoryScope(input.proposedScope, input.channelId)
    if (input.proposedScope === 'channel' && input.channelId !== run.scopeId) {
      throw new Error('Channel Memory candidate must match the Dream channel.')
    }
    const sourceMessageIds = [...new Set(input.sourceMessageIds)]
    for (const sourceMessageId of sourceMessageIds) assertDreamSource(database, run.scopeId, sourceMessageId)
    const createdAt = now()
    const candidate: MemoryCandidate = {
      id: randomUUID(), dreamRunId: input.dreamRunId, proposedScope: input.proposedScope, channelId: input.channelId,
      kind: input.kind, proposedContent: requireText(input.proposedContent, 'Memory candidate content'),
      rationale: requireText(input.rationale, 'Memory candidate rationale'),
      confidence: unitInterval(input.confidence, 'Memory candidate confidence'),
      importance: unitInterval(input.importance, 'Memory candidate importance'),
      contentHash: contentHash(input.proposedContent), status: 'pending', reviewedContent: null,
      reviewedScope: null, reviewedChannelId: null, reviewedAt: null, createdAt,
    }
    const existing = database.prepare(`
      SELECT * FROM memory_candidates
      WHERE dream_run_id = ? AND content_hash = ? AND proposed_scope = ? AND channel_id IS ?
      LIMIT 1
    `).get(
      candidate.dreamRunId, candidate.contentHash, candidate.proposedScope, candidate.channelId,
    ) as MemoryCandidateRow | undefined
    if (existing) {
      if (existing.status === 'pending') {
        this.insertMemoryCandidateSources(existing.id, sourceMessageIds)
        return mapMemoryCandidate(existing)
      }
      const recoverySuperseded = existing.status === 'superseded' && database.prepare(`
        SELECT 1 FROM dream_recovery_audit
        WHERE entity_type = 'memory_candidate'
          AND entity_id = ?
          AND error = 'invalid_candidate_sources'
          AND created_at = ?
      `).get(existing.id, existing.reviewed_at)
      if (!recoverySuperseded) {
        throw new Error('UNIQUE constraint failed: memory_candidates_run_content_unique_idx')
      }
      database.prepare(`
        UPDATE memory_candidates
        SET kind = ?, proposed_content = ?, rationale = ?, confidence = ?, importance = ?,
          status = 'pending', reviewed_content = NULL, reviewed_scope = NULL,
          reviewed_channel_id = NULL, reviewed_at = NULL
        WHERE id = ? AND status = 'superseded'
      `).run(
        candidate.kind, candidate.proposedContent, candidate.rationale, candidate.confidence,
        candidate.importance, existing.id,
      )
      this.insertMemoryCandidateSources(existing.id, sourceMessageIds)
      this.sqlite.afterCommit(() => this.publisher.publish(event(
        'memory.candidate_created', 'memory_candidate', existing.id, createdAt,
      )))
      return this.getMemoryCandidate(existing.id)!
    }
    database.prepare(`
      INSERT INTO memory_candidates (
        id, dream_run_id, proposed_scope, channel_id, kind, proposed_content, rationale, confidence,
        importance, content_hash, status, reviewed_content, reviewed_scope, reviewed_channel_id, reviewed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id, candidate.dreamRunId, candidate.proposedScope, candidate.channelId, candidate.kind,
      candidate.proposedContent, candidate.rationale, candidate.confidence, candidate.importance, candidate.contentHash,
      candidate.status, candidate.reviewedContent, candidate.reviewedScope, candidate.reviewedChannelId ?? null, candidate.reviewedAt, candidate.createdAt,
    )
    this.insertMemoryCandidateSources(candidate.id, sourceMessageIds)
    database.prepare('UPDATE dream_runs SET candidate_count = candidate_count + 1 WHERE id = ?').run(run.id)
    this.sqlite.afterCommit(() => this.publisher.publish(event('memory.candidate_created', 'memory_candidate', candidate.id, createdAt)))
    return candidate
  }

  private insertMemoryCandidateSources(candidateId: string, sourceMessageIds: string[]): void {
    const database = this.sqlite.database
    const insertSource = database.prepare(`
      INSERT OR IGNORE INTO memory_candidate_sources (candidate_id, message_id, turn_id) VALUES (?, ?, ?)
    `)
    for (const sourceMessageId of sourceMessageIds) {
      insertSource.run(candidateId, sourceMessageId, sourceTurnId(database, sourceMessageId))
    }
  }

  getMemoryCandidate(candidateId: string): MemoryCandidate | undefined {
    const row = this.sqlite.database.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(candidateId) as MemoryCandidateRow | undefined
    return row ? mapMemoryCandidate(row) : undefined
  }

  getMemoryByCandidateId(candidateId: string): MemoryRecord | undefined {
    const row = this.sqlite.database.prepare(`
      SELECT memories.*, source.confidence AS source_confidence, source.importance AS source_importance
      FROM memory_sources
      JOIN memories ON memories.id = memory_sources.memory_id
      JOIN memory_candidates AS source ON source.id = memories.source_candidate_id
      WHERE memory_sources.candidate_id = ?
      ORDER BY memories.created_at, memories.id
      LIMIT 1
    `).get(candidateId) as MemoryRow | undefined
    return row ? mapMemory(row) : undefined
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    return readMemory(this.sqlite.database, memoryId)
  }

  listMemoryCandidates(filter: MemoryCandidateFilter = {}): MemoryCandidate[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter.dreamRunId !== undefined) {
      clauses.push('dream_run_id = ?')
      values.push(filter.dreamRunId)
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      values.push(filter.status)
    }
    if (filter.proposedScope !== undefined) {
      clauses.push('proposed_scope = ?')
      values.push(filter.proposedScope)
    }
    if (filter.channelId !== undefined) {
      clauses.push('channel_id = ?')
      values.push(filter.channelId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.sqlite.database.prepare(`SELECT * FROM memory_candidates ${where} ORDER BY created_at, id`).all(...values) as unknown as MemoryCandidateRow[])
      .map(mapMemoryCandidate)
  }

  listMemoryCandidateSourceMetadata(candidateId: string): MemoryCandidateSourceMetadata[] {
    return this.sqlite.database.prepare(`
      SELECT messages.channel_id AS channel_id, channels.name AS channel_name, messages.id AS message_id,
        messages.thread_root_id AS thread_root_message_id
      FROM memory_candidate_sources
      JOIN messages ON messages.id = memory_candidate_sources.message_id
      JOIN channels ON channels.id = messages.channel_id
      WHERE memory_candidate_sources.candidate_id = ?
        AND messages.deleted_at IS NULL
      ORDER BY messages.created_at, messages.id
    `).all(candidateId).map((row) => {
      const source = row as { channel_id: string; channel_name: string; message_id: string; thread_root_message_id: string | null }
      return { channelId: source.channel_id, channelName: source.channel_name, messageId: source.message_id, threadRootMessageId: source.thread_root_message_id }
    })
  }

  reviewMemoryCandidate(input: ReviewMemoryCandidateInput): MemoryCandidate {
    return this.inTransaction(() => {
      const candidate = this.getMemoryCandidate(input.candidateId)
      if (!candidate) throw new Error(`Memory candidate ${input.candidateId} does not exist.`)
      if (candidate.status !== 'pending') throw new Error(`Memory candidate ${input.candidateId} is already reviewed.`)
      const reviewedAt = input.occurredAt.toISOString()
      this.sqlite.database.prepare(`
        UPDATE memory_candidates SET status = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'
      `).run(input.status, reviewedAt, candidate.id)
      this.sqlite.afterCommit(() => this.publisher.publish(event('memory.candidate_reviewed', 'memory_candidate', candidate.id, reviewedAt)))
      return { ...candidate, status: input.status, reviewedAt }
    })
  }

  createMemoryFromCandidate(input: CreateMemoryFromCandidateInput): MemoryRecord {
    return this.inTransaction(() => {
      const database = this.sqlite.database
      const candidate = this.getMemoryCandidate(input.candidateId)
      if (!candidate) throw new Error(`Memory candidate ${input.candidateId} does not exist.`)
      if (candidate.status !== 'pending') throw new Error(`Memory candidate ${input.candidateId} is already reviewed.`)
      const dreamRun = this.getDreamRun(candidate.dreamRunId)
      if (!dreamRun) throw new Error(`Dream run ${candidate.dreamRunId} does not exist.`)
      const reviewedContent = requireText(input.reviewedContent, 'Reviewed Memory content')
      const reviewedChannelId = input.reviewedChannelId === undefined
        ? input.reviewedScope === 'channel' ? candidate.channelId ?? dreamRun.scopeId : null
        : input.reviewedChannelId
      assertMemoryScope(input.reviewedScope, reviewedChannelId)
      if (reviewedChannelId !== null && !readChannel(database, reviewedChannelId)) {
        throw new Error(`Channel ${reviewedChannelId} does not exist.`)
      }
      const reviewedContentHash = contentHash(reviewedContent)
      const reviewedAt = input.occurredAt.toISOString()
      const existing = database.prepare(`
        SELECT * FROM memories
        WHERE scope = ? AND channel_id IS ? AND content_hash = ? AND archived_at IS NULL
      `).get(input.reviewedScope, reviewedChannelId, reviewedContentHash) as MemoryRow | undefined
      const memory = existing ? mapMemory(existing) : {
        id: randomUUID(), scope: input.reviewedScope, channelId: reviewedChannelId, kind: candidate.kind,
        content: reviewedContent, contentHash: reviewedContentHash, status: 'active' as const,
        sourceCandidateId: candidate.id, archivedAt: null, createdAt: reviewedAt, updatedAt: reviewedAt,
      }
      if (!existing) {
        database.prepare(`
          INSERT INTO memories (
            id, scope, channel_id, kind, content, content_hash, status, source_candidate_id,
            archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          memory.id, memory.scope, memory.channelId, memory.kind, memory.content, memory.contentHash, memory.status,
          memory.sourceCandidateId, memory.archivedAt, memory.createdAt, memory.updatedAt,
        )
      }
      database.prepare(`
        INSERT OR IGNORE INTO memory_sources (memory_id, candidate_id, message_id, turn_id)
        SELECT ?, ?, message_id, turn_id FROM memory_candidate_sources WHERE candidate_id = ?
      `).run(memory.id, candidate.id, candidate.id)
      const accepted = database.prepare(`
        UPDATE memory_candidates
        SET status = 'accepted', reviewed_content = ?, reviewed_scope = ?, reviewed_channel_id = ?, reviewed_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(reviewedContent, input.reviewedScope, reviewedChannelId, reviewedAt, candidate.id)
      if (accepted.changes !== 1) throw new Error(`Memory candidate ${candidate.id} is already reviewed.`)
      database.prepare(`
        UPDATE memory_candidates
        SET status = 'superseded', reviewed_at = ?
        WHERE id != ? AND status = 'pending' AND proposed_scope = ? AND channel_id IS ? AND content_hash = ?
      `).run(reviewedAt, candidate.id, input.reviewedScope, reviewedChannelId, reviewedContentHash)
      this.sqlite.afterCommit(() => this.publisher.publish(event('memory.candidate_reviewed', 'memory_candidate', candidate.id, reviewedAt)))
      this.sqlite.afterCommit(() => this.publisher.publish(event('memory.changed', 'memory', memory.id, reviewedAt)))
      return memory
    })
  }

  listAcceptedMemories(scope: MemoryScope, channelId?: string): MemoryRecord[] {
    assertMemoryScope(scope, channelId ?? null)
    const rows = this.sqlite.database.prepare(`
      SELECT memories.*, source.confidence AS source_confidence, source.importance AS source_importance
      FROM memories
      JOIN memory_candidates AS source ON source.id = memories.source_candidate_id
      WHERE memories.scope = ? AND memories.channel_id IS ? AND memories.status = 'active'
      ORDER BY memories.updated_at DESC, memories.id
    `).all(scope, channelId ?? null) as unknown as MemoryRow[]
    return rows.map(mapMemory)
  }

  updateMemory(memoryId: string, content: string): MemoryRecord {
    return this.inTransaction(() => {
      const existing = readMemory(this.sqlite.database, memoryId)
      if (!existing) throw new Error(`Memory ${memoryId} does not exist.`)
      if (existing.status !== 'active') throw new Error(`Memory ${memoryId} is archived.`)
      const updatedContent = requireText(content, 'Memory content')
      const updatedAt = now()
      const updatedContentHash = contentHash(updatedContent)
      const duplicate = this.sqlite.database.prepare(`
        SELECT id FROM memories
        WHERE id != ? AND scope = ? AND channel_id IS ? AND content_hash = ? AND archived_at IS NULL
      `).get(memoryId, existing.scope, existing.channelId, updatedContentHash)
      if (duplicate) throw new DomainError('An active Memory with the same content already exists.')
      this.sqlite.database.prepare(`
        UPDATE memories SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?
      `).run(updatedContent, updatedContentHash, updatedAt, memoryId)
      this.sqlite.afterCommit(() => this.publisher.publish(event('memory.changed', 'memory', memoryId, updatedAt)))
      return { ...existing, content: updatedContent, contentHash: updatedContentHash, updatedAt }
    })
  }

  archiveMemory(memoryId: string, occurredAt: Date): MemoryRecord {
    return this.inTransaction(() => {
      const existing = readMemory(this.sqlite.database, memoryId)
      if (!existing) throw new Error(`Memory ${memoryId} does not exist.`)
      if (existing.status === 'archived') return existing
      const archivedAt = occurredAt.toISOString()
      this.sqlite.database.prepare(`
        UPDATE memories SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?
      `).run(archivedAt, archivedAt, memoryId)
      this.sqlite.afterCommit(() => this.publisher.publish(event('memory.changed', 'memory', memoryId, archivedAt)))
      return { ...existing, status: 'archived', archivedAt, updatedAt: archivedAt }
    })
  }

  listDreamSourceMessages(runId: string): Message[] {
    const rows = this.sqlite.database.prepare(`
      SELECT messages.* FROM dream_run_sources
      JOIN messages ON messages.id = dream_run_sources.message_id
      WHERE dream_run_sources.dream_run_id = ?
      ORDER BY messages.created_at, messages.id
    `).all(runId) as unknown as MessageRow[]
    return rows.map(mapMessage)
  }

  getThreadSummary(channelId: string, threadRootMessageId: string): ThreadSummary | undefined {
    const row = this.sqlite.database.prepare(`
      SELECT * FROM thread_summaries WHERE channel_id = ? AND thread_root_message_id = ?
    `).get(channelId, threadRootMessageId) as ThreadSummaryRow | undefined
    return row ? mapThreadSummary(row) : undefined
  }

  upsertThreadSummary(input: UpsertThreadSummaryInput): ThreadSummary {
    return this.inTransaction(() => {
      const database = this.sqlite.database
      const root = readMessage(database, input.threadRootMessageId)
      if (!root || root.channelId !== input.channelId || root.threadRootMessageId !== null) {
        throw new Error('Thread summary root message must be a Timeline message in its channel.')
      }
      const through = readMessage(database, input.throughMessageId)
      if (!through || through.channelId !== input.channelId || through.createdAt !== input.throughMessageCreatedAt
        || (through.id !== root.id && through.threadRootMessageId !== root.id)) {
        throw new Error('Thread summary watermark must be a message in its Thread.')
      }
      const content = requireText(input.content, 'Thread summary content')
      const updatedAt = now()
      const existing = this.getThreadSummary(input.channelId, input.threadRootMessageId)
      if (existing?.throughMessageId) {
        const existingPosition = readMessagePosition(database, existing.throughMessageId)
        const nextPosition = readMessagePosition(database, input.throughMessageId)
        if (!existingPosition || !nextPosition) throw new Error('Thread summary watermark message does not exist.')
        if (compareMessagePositions(nextPosition, existingPosition) <= 0) return existing
      }
      database.prepare(`
        INSERT INTO thread_summaries (
          channel_id, thread_root_message_id, content, through_message_created_at, through_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, thread_root_message_id) DO UPDATE SET
          content = excluded.content,
          through_message_created_at = excluded.through_message_created_at,
          through_message_id = excluded.through_message_id,
          updated_at = excluded.updated_at
      `).run(
        input.channelId, input.threadRootMessageId, content, input.throughMessageCreatedAt, input.throughMessageId,
        existing?.createdAt ?? updatedAt, updatedAt,
      )
      return this.getThreadSummary(input.channelId, input.threadRootMessageId)!
    })
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

  listActiveConversationActivity(channelId?: string): ActiveConversationTurnProjection[] {
    const terminalStatuses = "'completed', 'partial', 'cancelled', 'failed'"
    const channelFilter = channelId === undefined ? '' : 'AND turns.channel_id = ?'
    const rows = this.sqlite.database.prepare(`
      SELECT
        turns.*,
        invocations.id AS invocation_id,
        invocations.agent_id AS invocation_agent_id,
        invocations.kind AS invocation_kind,
        invocations.priority AS invocation_priority,
        invocations.round AS invocation_round,
        invocations.status AS invocation_status,
        invocations.idempotency_key AS invocation_idempotency_key,
        invocations.source_invocation_id AS invocation_source_id,
        invocations.sequence AS invocation_sequence,
        invocations.queued_at AS invocation_queued_at,
        invocations.started_at AS invocation_started_at,
        invocations.completed_at AS invocation_completed_at,
        invocations.error_code AS invocation_error_code,
        invocations.result_json AS invocation_result_json
      FROM conversation_turns AS turns
      LEFT JOIN agent_invocations AS invocations
        ON invocations.turn_id = turns.id
        AND invocations.status IN ('queued', 'running')
      WHERE turns.status NOT IN (${terminalStatuses})
        ${channelFilter}
      ORDER BY turns.created_at, turns.id, invocations.sequence, invocations.id
    `).all(...(channelId === undefined ? [] : [channelId])) as unknown as ActiveConversationTurnRow[]

    const projections = new Map<string, ActiveConversationTurnProjection>()
    for (const row of rows) {
      const projection = projections.get(row.id) ?? { turn: mapConversationTurn(row), invocations: [] }
      if (row.invocation_id) {
        projection.invocations.push(mapAgentInvocation({
          id: row.invocation_id,
          turn_id: row.id,
          agent_id: row.invocation_agent_id!,
          kind: row.invocation_kind!,
          priority: row.invocation_priority!,
          round: row.invocation_round!,
          status: row.invocation_status!,
          idempotency_key: row.invocation_idempotency_key!,
          source_invocation_id: row.invocation_source_id,
          sequence: row.invocation_sequence!,
          queued_at: row.invocation_queued_at!,
          started_at: row.invocation_started_at,
          completed_at: row.invocation_completed_at,
          error_code: row.invocation_error_code,
          result_json: row.invocation_result_json,
        }))
      }
      projections.set(row.id, projection)
    }
    return [...projections.values()]
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

  claimRecoverableConversationTurns(
    ownerId: string,
    occurredAt: Date,
    staleBefore: Date,
  ): ActiveConversationTurnProjection[] {
    return this.inTransaction(() => {
      const occurredAtIso = occurredAt.toISOString()
      const staleBeforeIso = staleBefore.toISOString()
      const candidates = this.sqlite.database.prepare(`
        SELECT turns.id
        FROM conversation_turns AS turns
        LEFT JOIN agent_invocations AS invocations
          ON invocations.turn_id = turns.id
          AND invocations.status IN ('queued', 'running')
        WHERE turns.status NOT IN ('completed', 'partial', 'cancelled', 'failed')
          AND (turns.recovery_owner_id IS NULL OR turns.recovery_claimed_at < ?)
        GROUP BY turns.id
        ORDER BY MIN(CASE invocations.priority
          WHEN 'human_direct' THEN 0
          WHEN 'human_ordinary' THEN 1
          WHEN 'participation' THEN 2
          WHEN 'duplicate_check' THEN 3
          WHEN 'automatic_handoff' THEN 4
          ELSE 5
        END), turns.created_at, turns.id
      `).all(staleBeforeIso) as Array<{ id: string }>
      const claimedIds: string[] = []

      for (const candidate of candidates) {
        const claimed = this.sqlite.database.prepare(`
          UPDATE conversation_turns
          SET recovery_owner_id = ?, recovery_claimed_at = ?, updated_at = ?
          WHERE id = ?
            AND status NOT IN ('completed', 'partial', 'cancelled', 'failed')
            AND (recovery_owner_id IS NULL OR recovery_claimed_at < ?)
        `).run(ownerId, occurredAtIso, occurredAtIso, candidate.id, staleBeforeIso)
        if (claimed.changes !== 1) continue

        this.sqlite.database.prepare(`
          UPDATE agent_invocations
          SET status = 'queued', started_at = NULL, completed_at = NULL, error_code = NULL
          WHERE turn_id = ? AND status = 'running'
        `).run(candidate.id)
        claimedIds.push(candidate.id)
      }

      if (claimedIds.length === 0) return []
      const claimedIdSet = new Set(claimedIds)
      const projectionsById = new Map(
        this.listActiveConversationActivity()
          .filter((projection) => claimedIdSet.has(projection.turn.id))
          .map((projection) => [projection.turn.id, projection]),
      )
      return claimedIds.flatMap((turnId) => {
        const projection = projectionsById.get(turnId)
        return projection ? [projection] : []
      })
    })
  }

  withConversationTurnClaim<T>(
    turnId: string,
    ownerId: string,
    work: () => T,
  ): ConversationTurnClaimResult<T> {
    return this.inTransaction(() => {
      const claim = this.sqlite.database.prepare(`
        SELECT recovery_owner_id, status
        FROM conversation_turns
        WHERE id = ?
      `).get(turnId) as { recovery_owner_id: string | null; status: ConversationTurn['status'] } | undefined
      if (!claim
        || claim.recovery_owner_id !== ownerId
        || claim.status === 'completed'
        || claim.status === 'partial'
        || claim.status === 'cancelled'
        || claim.status === 'failed') {
        return { applied: false }
      }
      return { applied: true, value: work() }
    })
  }

  renewConversationTurnClaim(turnId: string, ownerId: string, occurredAt: Date): boolean {
    return this.inTransaction(() => {
      const occurredAtIso = occurredAt.toISOString()
      const renewed = this.sqlite.database.prepare(`
        UPDATE conversation_turns
        SET recovery_claimed_at = ?, updated_at = ?
        WHERE id = ? AND recovery_owner_id = ?
          AND status NOT IN ('completed', 'partial', 'cancelled', 'failed')
      `).run(occurredAtIso, occurredAtIso, turnId, ownerId)
      return renewed.changes === 1
    })
  }

  releaseConversationTurnClaim(turnId: string, ownerId: string): boolean {
    return this.inTransaction(() => {
      const released = this.sqlite.database.prepare(`
        UPDATE conversation_turns
        SET recovery_owner_id = NULL, recovery_claimed_at = NULL
        WHERE id = ? AND recovery_owner_id = ?
      `).run(turnId, ownerId)
      return released.changes === 1
    })
  }

  cancelConversationTurn(input: CancelConversationTurnInput): CancelConversationTurnResult {
    return this.inTransaction(() => {
      const turnRow = this.sqlite.database.prepare('SELECT * FROM conversation_turns WHERE id = ?')
        .get(input.turnId) as ConversationTurnRow | undefined
      if (!turnRow) throw new Error(`Conversation turn ${input.turnId} does not exist.`)
      const turn = mapConversationTurn(turnRow)
      const terminal = turn.status === 'completed' || turn.status === 'partial'
        || turn.status === 'cancelled' || turn.status === 'failed'
      const ownsTurn = input.expectedRecoveryOwnerId === undefined
        || turnRow.recovery_owner_id === input.expectedRecoveryOwnerId
      if (terminal || !ownsTurn) {
        return { applied: false, turn, invocationIds: [], participantIds: [], handoffIds: [] }
      }

      const invocationIds = (this.sqlite.database.prepare(`
        SELECT id FROM agent_invocations
        WHERE turn_id = ? AND status IN ('queued', 'running')
        ORDER BY sequence, id
      `).all(input.turnId) as Array<{ id: string }>).map(({ id }) => id)
      const participantIds = (this.sqlite.database.prepare(`
        SELECT id FROM turn_participants
        WHERE turn_id = ? AND status IN ('candidate', 'selected')
        ORDER BY rank, id
      `).all(input.turnId) as Array<{ id: string }>).map(({ id }) => id)
      const handoffIds = (this.sqlite.database.prepare(`
        SELECT id FROM conversation_handoffs
        WHERE turn_id = ? AND status IN ('queued', 'accepted')
        ORDER BY created_at, id
      `).all(input.turnId) as Array<{ id: string }>).map(({ id }) => id)
      const occurredAt = input.occurredAt.toISOString()

      this.sqlite.database.prepare(`
        UPDATE agent_invocations
        SET status = 'cancelled', completed_at = ?, error_code = 'cancelled'
        WHERE turn_id = ? AND status IN ('queued', 'running')
      `).run(occurredAt, input.turnId)
      this.sqlite.database.prepare(`
        UPDATE turn_participants
        SET status = 'cancelled', reason = ?, updated_at = ?
        WHERE turn_id = ? AND status IN ('candidate', 'selected')
      `).run(input.reason, occurredAt, input.turnId)
      this.sqlite.database.prepare(`
        UPDATE conversation_handoffs
        SET status = 'failed', reason = ?, updated_at = ?
        WHERE turn_id = ? AND status IN ('queued', 'accepted')
      `).run(input.reason, occurredAt, input.turnId)
      this.sqlite.database.prepare(`
        UPDATE conversation_turns
        SET status = 'cancelled', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(occurredAt, occurredAt, input.turnId)

      return {
        applied: true,
        turn: mapConversationTurn({
          ...turnRow,
          status: 'cancelled',
          completed_at: occurredAt,
          updated_at: occurredAt,
        }),
        invocationIds,
        participantIds,
        handoffIds,
      }
    })
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
        resultJson: patch.resultJson === undefined ? invocation.resultJson : patch.resultJson,
      }
      this.sqlite.database.prepare(`
        UPDATE agent_invocations
        SET status = ?, started_at = ?, completed_at = ?, error_code = ?, result_json = ?
        WHERE id = ?
      `).run(
        updated.status, updated.startedAt, updated.completedAt, updated.errorCode,
        updated.resultJson, updated.id,
      )
      return updated
    })
  }

  settleConversationInvocation(input: SettleConversationInvocationInput): SettleConversationInvocationResult {
    return this.inTransaction((unitOfWork) => {
      const invocationRow = this.sqlite.database.prepare('SELECT * FROM agent_invocations WHERE id = ?')
        .get(input.invocationId) as AgentInvocationRow | undefined
      if (!invocationRow) throw new Error(`Agent invocation ${input.invocationId} does not exist.`)
      const invocation = mapAgentInvocation(invocationRow)
      const turnRow = this.sqlite.database.prepare('SELECT * FROM conversation_turns WHERE id = ?')
        .get(invocation.turnId) as ConversationTurnRow | undefined
      if (!turnRow) throw new Error(`Conversation turn ${invocation.turnId} does not exist.`)
      const mappedMessage = this.sqlite.database.prepare(`
        SELECT messages.*
        FROM conversation_invocation_messages AS invocation_messages
        JOIN messages ON messages.id = invocation_messages.message_id
        WHERE invocation_messages.invocation_id = ?
      `).get(invocation.id) as MessageRow | undefined
      const participantRow = this.sqlite.database.prepare(`
        SELECT * FROM turn_participants WHERE turn_id = ? AND agent_id = ?
      `).get(invocation.turnId, invocation.agentId) as TurnParticipantRow | undefined

      const terminalStatuses: ConversationTurn['status'][] = ['completed', 'partial', 'cancelled', 'failed']
      const ownsTurn = input.recoveryOwnerId === null
        ? turnRow.recovery_owner_id === null
        : turnRow.recovery_owner_id === input.recoveryOwnerId
      if (terminalStatuses.includes(turnRow.status) || !ownsTurn) {
        return { applied: false, invocation }
      }
      if (invocation.status === 'settled' && (!input.publicReply || mappedMessage)) {
        return {
          applied: true,
          invocation,
          ...(participantRow ? { participant: mapTurnParticipant(participantRow) } : {}),
          ...(mappedMessage ? { message: mapMessage(mappedMessage) } : {}),
        }
      }
      if (invocation.status !== 'running') return { applied: false, invocation }

      let participant: TurnParticipant | undefined
      if (input.participantPatch) {
        participant = this.updateTurnParticipant(invocation.turnId, invocation.agentId, input.participantPatch)
      }

      let message: Message | undefined
      if (input.publicReply) {
        message = unitOfWork.createMessage({
          channelId: turnRow.channel_id,
          threadRootMessageId: turnRow.thread_root_message_id,
          taskId: null,
          senderType: 'agent',
          senderId: invocation.agentId,
          authorName: input.publicReply.authorName,
          body: input.publicReply.body,
        })
        this.sqlite.database.prepare(`
          INSERT INTO conversation_invocation_messages (invocation_id, message_id, created_at)
          VALUES (?, ?, ?)
        `).run(invocation.id, message.id, input.occurredAt.toISOString())
      }

      const completedAt = input.occurredAt.toISOString()
      this.sqlite.database.prepare(`
        UPDATE agent_invocations
        SET status = 'settled', completed_at = ?, error_code = NULL, result_json = ?
        WHERE id = ? AND status = 'running'
      `).run(completedAt, input.resultJson, invocation.id)
      if (input.recoveryOwnerId !== null) {
        this.sqlite.database.prepare(`
          UPDATE conversation_turns
          SET recovery_claimed_at = ?, updated_at = ?
          WHERE id = ? AND recovery_owner_id = ?
        `).run(completedAt, completedAt, invocation.turnId, input.recoveryOwnerId)
      }
      const settled = mapAgentInvocation({
        ...invocationRow,
        status: 'settled',
        completed_at: completedAt,
        error_code: null,
        result_json: input.resultJson,
      })
      return {
        applied: true,
        invocation: settled,
        ...(participant ? { participant } : {}),
        ...(message ? { message } : {}),
      }
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

  listMessagesAfterThreadWatermark(
    channelId: string,
    threadRootMessageId: string,
    throughMessageId: string,
  ): Message[] {
    const rows = this.sqlite.database.prepare(`
      WITH watermark AS (
        SELECT messages.created_at, messages.rowid
        FROM messages
        WHERE messages.id = ?
          AND messages.channel_id = ?
          AND (messages.id = ? OR messages.thread_root_id = ?)
      )
      SELECT messages.*
      FROM messages
      JOIN channels ON channels.id = messages.channel_id
      JOIN watermark
      WHERE messages.channel_id = ?
        AND (messages.id = ? OR messages.thread_root_id = ?)
        AND messages.deleted_at IS NULL
        AND (channels.context_reset_at IS NULL OR messages.created_at > channels.context_reset_at)
        AND (
          messages.created_at > watermark.created_at
          OR (messages.created_at = watermark.created_at AND messages.rowid > watermark.rowid)
        )
      ORDER BY messages.created_at, messages.rowid
    `).all(
      throughMessageId, channelId, threadRootMessageId, threadRootMessageId,
      channelId, threadRootMessageId, threadRootMessageId,
    )
    return (rows as unknown as MessageRow[]).map(mapMessage)
  }

  listPublicMessagesForTurn(turnId: string): Message[] {
    const rows = this.sqlite.database.prepare(`
      SELECT messages.*
      FROM agent_invocations
      JOIN conversation_invocation_messages
        ON conversation_invocation_messages.invocation_id = agent_invocations.id
      JOIN messages ON messages.id = conversation_invocation_messages.message_id
      WHERE agent_invocations.turn_id = ?
        AND messages.deleted_at IS NULL
      ORDER BY messages.created_at, messages.rowid
    `).all(turnId) as unknown as MessageRow[]
    return rows.map(mapMessage)
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
      pendingMemoryCandidateCount: (database.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidates WHERE status = 'pending'",
      ).get() as { count: number }).count,
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

function readMemory(database: DatabaseSync, memoryId: string): MemoryRecord | undefined {
  const row = database.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as MemoryRow | undefined
  return row ? mapMemory(row) : undefined
}

function assertDreamBoundary(
  database: DatabaseSync,
  channelId: string,
  boundary: { createdAt: string; id: string } | null,
): void {
  if (!boundary) return
  const message = readMessage(database, boundary.id)
  if (!message || message.channelId !== channelId || message.createdAt !== boundary.createdAt) {
    throw new Error('Dream boundary must be a message from the Dream channel at the recorded time.')
  }
}

function assertDreamSource(database: DatabaseSync, channelId: string, messageId: string): void {
  const message = readMessage(database, messageId)
  if (!message || message.channelId !== channelId) {
    throw new Error('Memory candidate source message must belong to the Dream channel.')
  }
}

function assertMemoryScope(scope: MemoryScope, channelId: string | null): void {
  if ((scope === 'channel' && channelId === null) || (scope === 'global' && channelId !== null)) {
    throw new Error(`A ${scope} Memory record must ${scope === 'channel' ? 'have' : 'not have'} a channel.`)
  }
}

function sourceTurnId(database: DatabaseSync, messageId: string): string | null {
  const row = database.prepare(`
    SELECT id FROM conversation_turns WHERE trigger_message_id = ?
    UNION
    SELECT agent_invocations.turn_id AS id
    FROM conversation_invocation_messages
    JOIN agent_invocations ON agent_invocations.id = conversation_invocation_messages.invocation_id
    WHERE conversation_invocation_messages.message_id = ?
    LIMIT 1
  `).get(messageId, messageId) as { id: string } | undefined
  return row?.id ?? null
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

function mapDreamRun(row: DreamRunRow): DreamRun {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    trigger: row.trigger,
    status: row.status,
    fromMessageCreatedAt: row.from_message_created_at,
    fromMessageId: row.from_message_id,
    toMessageCreatedAt: row.to_message_created_at,
    toMessageId: row.to_message_id,
    candidateCount: row.candidate_count,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function mapMemoryCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    dreamRunId: row.dream_run_id,
    proposedScope: row.proposed_scope,
    channelId: row.channel_id,
    kind: row.kind,
    proposedContent: row.proposed_content,
    rationale: row.rationale,
    confidence: row.confidence,
    importance: row.importance,
    contentHash: row.content_hash,
    status: row.status,
    reviewedContent: row.reviewed_content,
    reviewedScope: row.reviewed_scope,
    reviewedChannelId: row.reviewed_channel_id,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  }
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    channelId: row.channel_id,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    status: row.status,
    sourceCandidateId: row.source_candidate_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceConfidence: row.source_confidence,
    sourceImportance: row.source_importance,
  }
}

function mapThreadSummary(row: ThreadSummaryRow): ThreadSummary {
  return {
    channelId: row.channel_id,
    threadRootMessageId: row.thread_root_message_id,
    content: row.content,
    throughMessageCreatedAt: row.through_message_created_at,
    throughMessageId: row.through_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface MessagePosition {
  createdAt: string
  rowId: number
}

function readMessagePosition(database: DatabaseSync, messageId: string): MessagePosition | undefined {
  return database.prepare(`
    SELECT created_at AS createdAt, rowid AS rowId FROM messages WHERE id = ?
  `).get(messageId) as MessagePosition | undefined
}

function compareMessagePositions(left: MessagePosition, right: MessagePosition): number {
  return left.createdAt.localeCompare(right.createdAt) || left.rowId - right.rowId
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
    resultJson: row.result_json,
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

function contentHash(content: string): string {
  return createHash('sha256').update(requireText(content, 'Memory content')).digest('hex')
}

function unitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`)
  }
  return value
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} is required.`)
  }
  return trimmed
}
