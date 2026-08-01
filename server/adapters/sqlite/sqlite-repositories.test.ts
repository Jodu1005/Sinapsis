import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../app'
import { DomainError, transitionTask, type Task } from '../../domain/task'
import type { DomainEvent } from '../../domain/events'
import type { DomainEventPublisher } from '../../ports/domain-event-publisher'
import { summitSystemKey } from '../../../shared/channel-policy'
import { createSqliteDatabase, type SqliteDatabase } from './database'
import { SqliteRepositories } from './sqlite-repositories'
import { startHttpTestServer } from '../../test/http-test-server'

class RecordingPublisher implements DomainEventPublisher {
  readonly events: DomainEvent[] = []
  onPublish?: (event: DomainEvent) => void

  publish(event: DomainEvent): void {
    this.events.push(event)
    this.onPublish?.(event)
  }
}

describe('SQLite workspace repositories', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    database = undefined

    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      temporaryDirectory = undefined
    }
  })

  it('publishes a channel message event only after its transaction commits', async () => {
    const { repositories, publisher } = await createRepositories()
    const channel = createChannel(repositories)
    let messageWasVisibleWhenPublished = false

    publisher.onPublish = (event) => {
      messageWasVisibleWhenPublished = repositories.getMessage(event.entityId) !== undefined
    }

    repositories.inTransaction((unitOfWork) => {
      unitOfWork.createMessage({
        channelId: channel.id,
        senderType: 'human',
        authorName: 'Jodu',
        body: 'Please add the local task queue.',
      })

      expect(publisher.events).toEqual([])
    })

    expect(publisher.events).toHaveLength(1)
    expect(publisher.events[0]).toMatchObject({
      type: 'message.created',
      entityType: 'message',
    })
    expect(messageWasVisibleWhenPublished).toBe(true)
  })

  it('does not publish nested transaction events when the enclosing transaction rolls back', async () => {
    const { repositories, publisher } = await createRepositories()
    const channel = createChannel(repositories)

    expect(() => {
      repositories.inTransaction(() => {
        repositories.inTransaction((unitOfWork) => {
          unitOfWork.createMessage({
            channelId: channel.id,
            senderType: 'human',
            authorName: 'Jodu',
            body: 'This message must disappear with the enclosing transaction.',
          })
        })

        throw new Error('roll back enclosing transaction')
      })
    }).toThrow('roll back enclosing transaction')

    expect(publisher.events).toEqual([])
  })

  it('does not publish repository events when a database transaction rolls back', async () => {
    const { repositories, publisher } = await createRepositories()
    const channel = createChannel(repositories)

    expect(() => {
      database!.transaction(() => {
        repositories.createMessage({
          channelId: channel.id,
          senderType: 'human',
          authorName: 'Jodu',
          body: 'This message must disappear with the database transaction.',
        })

        throw new Error('roll back database transaction')
      })
    }).toThrow('roll back database transaction')

    expect(publisher.events).toEqual([])
    expect(repositories.getBootstrap().recentMessages).toEqual([])
  })

  it('rejects moving an accepted task back to queued', () => {
    const acceptedTask: Task = {
      id: 'task-1',
      workspaceId: 'workspace-1',
      repositoryId: 'repository-1',
      channelId: 'channel-1',
      directAgentId: null,
      title: 'Review the pull request',
      description: 'Confirm the acceptance criteria.',
      acceptanceCriteria: 'The checks are green.',
      labels: [],
      status: 'accepted',
      queuedAt: '2026-07-24T00:00:00.000Z',
      attemptCount: 1,
      maxRetries: 2,
      timeoutMs: 900000,
      leaseTtlMs: null,
      branchName: null,
      worktreePath: null,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    }

    expect(() => transitionTask(acceptedTask, 'queued', 'review is complete')).toThrow(DomainError)
  })

  it('does not alter task state when a human message is edited or deleted', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const repositoryId = repositories.getBootstrap().workspaces[0]!.repositories[0]!.id
    const task = repositories.createTask({
      repositoryId,
      channelId: channel.id,
      title: 'Build the queue',
      description: 'Persist queued tasks.',
      acceptanceCriteria: 'Queued tasks survive restart.',
    })
    const message = repositories.createMessage({
      channelId: channel.id,
      taskId: task.id,
      senderType: 'human',
      authorName: 'Jodu',
      body: 'This wording will change.',
    })

    repositories.updateMessageBody(message.id, 'This wording changed.')
    repositories.deleteMessage(message.id)

    expect(repositories.getTask(task.id)?.status).toBe('queued')
  })

  it('stores replies under a root message and rejects roots from another channel', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const root = repositories.createMessage({ channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: '讨论任务调度。' })
    const reply = repositories.createMessage({ channelId: channel.id, threadRootMessageId: root.id, senderType: 'agent', authorName: 'Newton', body: '我会先检查队列。' })
    const otherChannel = repositories.createChannel({ name: 'release' })

    expect(repositories.getBootstrap().recentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: reply.id, threadRootMessageId: root.id }),
    ]))
    expect(() => repositories.createMessage({ channelId: otherChannel.id, threadRootMessageId: root.id, senderType: 'human', authorName: 'Jodu', body: '不能跨频道回复。' }))
      .toThrow('Thread root must be a root message in the same channel.')
  })

  it('persists conversation records with deterministic ordering and complete message context', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const firstAgent = repositories.createAgent({
      identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const secondAgent = repositories.createAgent({
      identity: 'Ada', mentionName: 'ada', runtime: 'claude-code', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: {},
    })
    const staleMessage = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Old context.',
    })
    database!.database.prepare('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?').run(
      '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', staleMessage.id,
    )
    database!.database.prepare('UPDATE channels SET context_reset_at = ? WHERE id = ?').run(
      '2026-07-30T01:00:00.000Z', channel.id,
    )
    const timelineMessages = Array.from({ length: 10 }, (_, index) => repositories.createMessage({
      channelId: channel.id,
      senderType: index === 9 ? 'agent' : 'human',
      senderId: index === 9 ? firstAgent.id : null,
      authorName: index === 9 ? firstAgent.identity : 'Jodu',
      body: `Timeline ${index + 1}`,
    }))
    const threadRoot = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Thread root.',
    })
    const threadReplies = [
      repositories.createMessage({
        channelId: channel.id, threadRootMessageId: threadRoot.id, senderType: 'agent',
        senderId: secondAgent.id, authorName: secondAgent.identity, body: 'First reply.',
      }),
      repositories.createMessage({
        channelId: channel.id, threadRootMessageId: threadRoot.id, senderType: 'human',
        authorName: 'Jodu', body: 'Second reply.',
      }),
    ]

    const turn = repositories.createConversationTurn({
      channelId: channel.id,
      triggerMessageId: timelineMessages[0]!.id,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })
    const participant = repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: firstAgent.id,
      source: 'responsibility',
      rank: 0,
      matcherScore: 18,
    })
    const firstInvocation = repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: firstAgent.id,
      kind: 'participation',
      priority: 'participation',
      round: 0,
      idempotencyKey: `${turn.id}:${firstAgent.id}:participation`,
      sourceInvocationId: null,
    })
    const secondInvocation = repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: secondAgent.id,
      kind: 'response',
      priority: 'human_ordinary',
      round: 0,
      idempotencyKey: `${turn.id}:${secondAgent.id}:response`,
      sourceInvocationId: firstInvocation.id,
    })
    const handoff = repositories.createConversationHandoff({
      turnId: turn.id,
      sourceInvocationId: secondInvocation.id,
      fromAgentId: secondAgent.id,
      requestedTargetAgentId: firstAgent.id,
      toAgentId: firstAgent.id,
      question: 'Can you verify the queue boundary?',
      round: 1,
    })
    const session = repositories.upsertConversationSession({
      key: `${channel.id}:timeline:${firstAgent.id}`,
      channelId: channel.id,
      threadRootMessageId: null,
      agentId: firstAgent.id,
      runtime: 'pi',
      runtimeSessionId: 'session-1',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: timelineMessages[0]!.id,
    })

    expect(turn).toMatchObject({ status: 'screening', currentRound: 0, completedAt: null })
    expect(participant).toMatchObject({
      decision: 'pending', confidence: null, proposedAngle: null, dependsOnAgentId: null,
      speakingOrder: null, status: 'candidate', reason: null,
    })
    expect(repositories.updateConversationTurn(turn.id, {
      status: 'judging', currentRound: 1,
    })).toMatchObject({ status: 'judging', currentRound: 1 })
    expect(repositories.updateTurnParticipant(turn.id, firstAgent.id, {
      decision: 'speak', confidence: 0.9, proposedAngle: 'Transaction safety',
      speakingOrder: 0, status: 'selected', reason: 'Strong responsibility match.',
    })).toMatchObject({ decision: 'speak', status: 'selected', speakingOrder: 0 })
    expect(repositories.updateAgentInvocation(secondInvocation.id, {
      status: 'running', startedAt: '2026-07-31T10:00:00.000Z',
    })).toMatchObject({ status: 'running', startedAt: '2026-07-31T10:00:00.000Z' })
    expect(repositories.listAgentInvocations(turn.id).map((invocation) => invocation.id)).toEqual([
      firstInvocation.id, secondInvocation.id,
    ])
    expect(repositories.listTurnParticipants(turn.id)).toEqual([
      expect.objectContaining({ id: participant.id, agentId: firstAgent.id }),
    ])
    expect(repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ id: handoff.id, status: 'queued', reason: null }),
    ])
    expect(repositories.listMessagesForConversation(channel.id, null).map((message) => message.id)).toEqual([
      ...timelineMessages.map((message) => message.id), threadRoot.id,
    ])
    expect(repositories.listMessagesForConversation(channel.id, threadRoot.id).map((message) => message.id)).toEqual([
      threadRoot.id, ...threadReplies.map((message) => message.id),
    ])
    expect(repositories.getLastAgentSpokenAt(channel.id, firstAgent.id)).toBe(timelineMessages[9]!.createdAt)

    const updatedSession = repositories.upsertConversationSession({
      key: session.key,
      channelId: channel.id,
      threadRootMessageId: null,
      agentId: firstAgent.id,
      runtime: 'claude-code',
      runtimeSessionId: 'session-2',
      runtimeSessionFile: '/tmp/session-2.jsonl',
      status: 'active',
      lastMessageId: timelineMessages[9]!.id,
    })
    expect(updatedSession).toMatchObject({
      id: session.id, createdAt: session.createdAt, runtimeSessionId: 'session-2',
      runtime: 'claude-code', runtimeSessionFile: '/tmp/session-2.jsonl',
      status: 'active', lastMessageId: timelineMessages[9]!.id,
    })
    expect(repositories.getConversationSession(session.key)).toEqual(updatedSession)
    expect(() => repositories.createConversationTurn({
      channelId: channel.id,
      triggerMessageId: timelineMessages[0]!.id,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })).toThrow(/UNIQUE constraint failed/)
    expect(() => repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: firstAgent.id,
      kind: 'participation',
      priority: 'participation',
      round: 1,
      idempotencyKey: firstInvocation.idempotencyKey,
      sourceInvocationId: null,
    })).toThrow(/UNIQUE constraint failed/)
  })

  it('rejects a second conversation session key for the same timeline grain', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Timeline message.',
    })
    const sessionInput = {
      channelId: channel.id,
      threadRootMessageId: null,
      agentId: agent.id,
      runtime: 'pi' as const,
      runtimeSessionId: 'session-1',
      runtimeSessionFile: null,
      status: 'ready' as const,
      lastMessageId: message.id,
    }

    repositories.upsertConversationSession({ key: 'timeline-key-1', ...sessionInput })

    expect(() => repositories.upsertConversationSession({ key: 'timeline-key-2', ...sessionInput }))
      .toThrow(/UNIQUE constraint failed/)
  })

  it('rejects moving an existing conversation session key to another identity grain', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const otherChannel = repositories.createChannel({ name: 'research' })
    const agent = repositories.createAgent({
      identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const otherAgent = repositories.createAgent({
      identity: 'Ada', mentionName: 'ada', runtime: 'claude-code', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Timeline message.',
    })
    const threadRoot = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Thread root.',
    })
    const input = {
      key: 'stable-session-key',
      channelId: channel.id,
      threadRootMessageId: null,
      agentId: agent.id,
      runtime: 'pi' as const,
      runtimeSessionId: 'session-1',
      runtimeSessionFile: null,
      status: 'ready' as const,
      lastMessageId: message.id,
    }
    repositories.upsertConversationSession(input)

    for (const identityPatch of [
      { channelId: otherChannel.id },
      { threadRootMessageId: threadRoot.id },
      { agentId: otherAgent.id },
    ]) {
      expect(() => repositories.upsertConversationSession({ ...input, ...identityPatch }))
        .toThrow('Conversation session stable-session-key identity cannot change.')
    }

    expect(repositories.getConversationSession(input.key)).toMatchObject({
      channelId: channel.id, threadRootMessageId: null, agentId: agent.id,
    })
  })

  it('rolls back a turn, participant, and initial invocation as one unit', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const trigger = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Start a turn.',
    })
    let turnId = ''

    expect(() => repositories.inTransaction((unitOfWork) => {
      const turn = unitOfWork.createConversationTurn({
        channelId: channel.id, triggerMessageId: trigger.id, threadRootMessageId: null,
        mode: 'ordinary', maxRounds: 3,
      })
      turnId = turn.id
      unitOfWork.createTurnParticipant({
        turnId: turn.id, agentId: agent.id, source: 'responsibility', rank: 0, matcherScore: 18,
      })
      unitOfWork.createAgentInvocation({
        turnId: turn.id, agentId: agent.id, kind: 'participation', priority: 'participation',
        round: 0, idempotencyKey: `${turn.id}:${agent.id}:participation`, sourceInvocationId: null,
      })
      throw new Error('roll back conversation setup')
    })).toThrow('roll back conversation setup')

    expect(repositories.getConversationTurn(turnId)).toBeUndefined()
    expect(repositories.listTurnParticipants(turnId)).toEqual([])
    expect(repositories.listAgentInvocations(turnId)).toEqual([])
  })

  it('changes ordinary channel membership only through explicit relationship operations', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const workspaceId = repositories.getBootstrap().workspaces[0]!.id
    const summit = repositories.createChannel({ name: 'summit', systemKey: 'summit' })
    const agent = repositories.createAgent({ identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {} })

    expect(repositories.getChannelAgentIds(channel.id)).toEqual([])
    expect(repositories.getChannelAgentIds(summit.id)).toEqual([agent.id])
    expect(database!.database.prepare('SELECT 1 FROM channel_agent_memberships WHERE channel_id = ? AND agent_id = ?').get(summit.id, agent.id)).toBeUndefined()

    repositories.addChannelAgent(channel.id, agent.id, new Date('2026-07-29T01:00:00.000Z'))
    repositories.addChannelAgent(channel.id, agent.id, new Date('2026-07-29T01:01:00.000Z'))
    expect(repositories.getChannelAgentIds(channel.id)).toEqual([agent.id])
    repositories.removeChannelAgent(channel.id, agent.id)
    repositories.removeChannelAgent(channel.id, agent.id)
    expect(repositories.getChannelAgentIds(channel.id)).toEqual([])

    repositories.bindChannelWorkspace(channel.id, workspaceId, new Date('2026-07-29T01:02:00.000Z'))
    repositories.bindChannelWorkspace(channel.id, workspaceId, new Date('2026-07-29T01:03:00.000Z'))
    expect(repositories.getChannelWorkspaceIds(channel.id)).toEqual([workspaceId])
    repositories.unbindChannelWorkspace(channel.id, workspaceId)
    repositories.unbindChannelWorkspace(channel.id, workspaceId)
    expect(repositories.getChannelWorkspaceIds(channel.id)).toEqual([])

    expect(() => repositories.addChannelAgent(summit.id, agent.id, new Date())).toThrow('Summit membership is managed dynamically.')
    expect(() => repositories.removeChannelAgent(summit.id, agent.id)).toThrow('Summit membership is managed dynamically.')
  })

  it('does not infer system capabilities from the summit display name', async () => {
    const { repositories } = await createRepositories()
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'control-room', path: '/projects/control-room' })

    const ordinarySummit = repositories.createChannel({ name: 'summit' })
    const systemSummit = repositories.inTransaction((unitOfWork) =>
      unitOfWork.ensureSystemChannel({ name: 'system-summit', systemKey: summitSystemKey }))

    expect(ordinarySummit).toMatchObject({ name: 'summit', systemKey: null })
    expect(systemSummit).toMatchObject({ name: 'system-summit', systemKey: summitSystemKey })
    expect(repositories.inTransaction((unitOfWork) =>
      unitOfWork.ensureSystemChannel({ name: 'ignored', systemKey: summitSystemKey })).id).toBe(systemSummit.id)
  })

  it('treats direct assignment and active leases as unfinished Agent work', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const workspaceId = repositories.getBootstrap().workspaces[0]!.id
    const repositoryId = repositories.getBootstrap().workspaces[0]!.repositories[0]!.id
    const agent = repositories.createAgent({ identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {} })
    const direct = repositories.createTask({
      repositoryId, channelId: channel.id, directAgentId: agent.id,
      title: 'Direct task', description: 'Description', acceptanceCriteria: 'Done',
    })

    expect(repositories.hasUnfinishedTask(channel.id, workspaceId, agent.id)).toBe(true)
    repositories.transitionTask(direct.id, 'cancelled', 'No longer needed')

    const shared = repositories.createTask({
      repositoryId, channelId: channel.id,
      title: 'Shared task', description: 'Description', acceptanceCriteria: 'Done',
    })
    repositories.setAgentStatus(agent.id, 'idle', new Date('2026-07-29T02:00:00.000Z'))
    repositories.addChannelAgent(channel.id, agent.id, new Date('2026-07-29T02:00:00.000Z'))
    expect(repositories.hasUnfinishedTask(channel.id, workspaceId, agent.id)).toBe(false)
    expect(repositories.claimNextTask(agent.id, new Date('2026-07-29T02:01:00.000Z'))?.task.id).toBe(shared.id)
    expect(repositories.hasUnfinishedTask(channel.id, workspaceId, agent.id)).toBe(true)
  })

  it('hides pre-reset channel messages and tasks from the current bootstrap context', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const repositoryId = repositories.getBootstrap().workspaces[0]!.repositories[0]!.id
    const beforeReset = repositories.createTask({
      repositoryId,
      channelId: channel.id,
      title: '旧任务',
      description: '这条任务应保留在存储中。',
      acceptanceCriteria: '不出现在当前上下文。',
    })
    const beforeMessage = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'Jodu',
      body: '这条消息应保留在存储中。',
    })

    const resetAt = new Date()
    repositories.resetChannelContext(channel.id, resetAt)

    await new Promise((resolve) => setTimeout(resolve, 1))

    const afterReset = repositories.createTask({
      repositoryId,
      channelId: channel.id,
      title: '新任务',
      description: '这条任务属于新的上下文。',
      acceptanceCriteria: '显示在当前上下文。',
    })
    const afterMessage = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'Jodu',
      body: '这条消息属于新的上下文。',
    })

    const snapshot = repositories.getBootstrap()
    expect(repositories.getTask(beforeReset.id)).toBeDefined()
    expect(repositories.getMessage(beforeMessage.id)).toBeDefined()
    expect(snapshot.tasks.map((task) => task.id)).toEqual([afterReset.id])
    expect(snapshot.recentMessages.map((message) => message.id)).toEqual([afterMessage.id])
    expect(snapshot.channels[0]).toMatchObject({ contextResetAt: resetAt.toISOString() })
  })

  it('returns global control-room entities without nesting channel state under workspaces', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const workspace = repositories.getBootstrap().workspaces[0]!
    const repository = workspace.repositories[0]!
    const agent = repositories.createAgent({
      identity: 'Newton',
      mentionName: 'newton',
      runtime: 'pi',
      capabilityTags: ['general'],
      maxConcurrentTasks: 1,
      command: 'pi',
      args: [],
      model: '',
      env: {},
    })
    repositories.addChannelAgent(channel.id, agent.id, new Date('2026-07-29T03:00:00.000Z'))
    repositories.bindChannelWorkspace(channel.id, workspace.id, new Date('2026-07-29T03:00:00.000Z'))
    const task = repositories.createTask({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      channelId: channel.id,
      title: 'Global snapshot',
      description: 'Expose control-room entities once.',
      acceptanceCriteria: 'No nested channel state remains.',
    })
    const message = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'Jodu',
      body: 'Show the global snapshot.',
    })

    const snapshot = repositories.getBootstrap()

    expect(snapshot.agents).toEqual([expect.objectContaining({ id: agent.id })])
    expect(snapshot.channels).toEqual([
      expect.objectContaining({
        id: channel.id,
        memberAgentIds: [agent.id],
        boundWorkspaceIds: [workspace.id],
      }),
    ])
    expect(snapshot.tasks).toEqual([expect.objectContaining({ id: task.id })])
    expect(snapshot.recentMessages).toEqual([expect.objectContaining({ id: message.id })])
    expect(snapshot.maxWorkspaceBindingsPerChannel).toBe(5)
    expect(snapshot.workspaces[0]).not.toHaveProperty('agents')
    expect(snapshot.workspaces[0]).not.toHaveProperty('channels')
    expect(snapshot.workspaces[0].repositories[0]).not.toHaveProperty('tasks')
    expect(snapshot.workspaces[0].repositories[0]).not.toHaveProperty('channels')
  })

  it('keeps recent history for each channel when another channel is busy', async () => {
    const { repositories } = await createRepositories()
    const quietChannel = createChannel(repositories)
    const busyChannel = repositories.createChannel({ name: 'busy' })
    const quietMessage = repositories.createMessage({
      channelId: quietChannel.id,
      senderType: 'human',
      authorName: 'Jodu',
      body: 'Keep this quiet-channel context.',
    })
    for (let index = 0; index < 50; index += 1) {
      repositories.createMessage({
        channelId: busyChannel.id,
        senderType: 'human',
        authorName: 'Jodu',
        body: `Busy message ${index + 1}`,
      })
    }

    const recentMessages = repositories.getBootstrap().recentMessages

    expect(recentMessages.filter((message) => message.channelId === quietChannel.id)).toEqual([
      expect.objectContaining({ id: quietMessage.id }),
    ])
    expect(recentMessages.filter((message) => message.channelId === busyChannel.id)).toHaveLength(50)
  })

  it('resolves summit membership dynamically in the global bootstrap snapshot', async () => {
    const { repositories } = await createRepositories()
    createChannel(repositories)
    const summit = repositories.createChannel({ name: 'summit', systemKey: summitSystemKey })
    const newton = repositories.createAgent({
      identity: 'Newton',
      mentionName: 'newton',
      runtime: 'pi',
      capabilityTags: [],
      maxConcurrentTasks: 1,
      command: 'pi',
      args: [],
      model: '',
      env: {},
    })
    const clawd = repositories.createAgent({
      identity: 'Clawd',
      mentionName: 'clawd',
      runtime: 'claude-code',
      capabilityTags: [],
      maxConcurrentTasks: 1,
      command: 'claude',
      args: [],
      model: '',
      env: {},
    })

    const snapshot = repositories.getBootstrap()
    const snapshotSummit = snapshot.channels.find((channel) => channel.id === summit.id)

    expect(snapshotSummit?.memberAgentIds).toEqual(snapshot.agents.map((agent) => agent.id))
    expect(snapshotSummit?.memberAgentIds).toEqual(expect.arrayContaining([newton.id, clawd.id]))
  })

  it('returns an empty bootstrap snapshot for a new database', async () => {
    const databasePath = await createDatabasePath()
    const app = createApp({ databasePath })
    const server = await startHttpTestServer(app)

    try {
      const response = await fetch(`${server.baseUrl}/api/bootstrap`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        agents: [],
        channels: [],
        workspaces: [],
        tasks: [],
        recentMessages: [],
        maxWorkspaceBindingsPerChannel: 5,
        typingAgentIdsByChannel: {},
      })
    } finally {
      await server.close()
      app.locals.closeDatabase()
    }
  })

  it('releases a busy Agent without a task lease during service recovery', async () => {
    const { repositories } = await createRepositories()
    createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'newton',
      mentionName: 'dev',
      runtime: 'pi',
      capabilityTags: [],
      maxConcurrentTasks: 1,
      command: 'pi',
      args: [],
      model: '',
      env: {},
    })
    repositories.setAgentStatus(agent.id, 'busy', new Date('2026-07-26T04:00:00.000Z'))

    expect(repositories.recoverOrphanedAgents(new Date('2026-07-26T05:00:00.000Z'))).toBe(1)
    expect(repositories.getAgent(agent.id)).toMatchObject({ status: 'idle', updatedAt: '2026-07-26T05:00:00.000Z' })
  })

  it('archives legacy duplicate channel names and enforces global active-channel uniqueness', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const repositoryId = repositories.getBootstrap().workspaces[0]!.repositories[0]!.id
    const secondWorkspace = repositories.createWorkspace({ name: 'WorkCode' })
    const secondRepository = repositories.createRepository({ workspaceId: secondWorkspace.id, name: 'workcode', path: '/projects/workcode' })
    database!.database.exec('DROP INDEX channels_active_normalized_name_unique_idx')
    database!.database.prepare('DELETE FROM schema_migrations WHERE version = 7').run()
    database!.database.prepare('INSERT INTO channels (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      'legacy-duplicate-channel', secondRepository.id, channel.name, '2026-07-24T00:00:00.000Z',
    )
    database!.close()
    database = undefined
    database = createSqliteDatabase(databasePath)

    const channels = database.database.prepare('SELECT id, name, archived_at FROM channels WHERE name = ? ORDER BY created_at, id').all(channel.name)
    expect(channels).toEqual([
      { id: 'legacy-duplicate-channel', name: 'engineering', archived_at: null },
      expect.objectContaining({ name: 'engineering', archived_at: expect.any(String) }),
    ])
    expect(() => database!.database.prepare('INSERT INTO channels (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      'another-duplicate-channel', repositoryId, 'engineering', '2026-07-25T00:00:00.000Z',
    )).toThrow(/UNIQUE constraint failed/)
  })

  it('migrates a version 13 database to global channel relationships', async () => {
    const databasePath = await createDatabasePath()
    const fixture = createVersion13Fixture(databasePath)

    database = createSqliteDatabase(databasePath)
    const repositories = new SqliteRepositories(database, new RecordingPublisher())

    expect(repositories.getChannel(fixture.summitId)).toMatchObject({
      systemKey: summitSystemKey,
      memberAgentIds: [fixture.agentId],
      boundWorkspaceIds: [fixture.workspaceId],
    })
    expect(repositories.getChannel(fixture.ordinaryChannelId)?.memberAgentIds).toContain(fixture.agentId)
    expect(repositories.getTask(fixture.taskId)).toMatchObject({ workspaceId: fixture.workspaceId })

    const createdAgent = repositories.createAgent({
      identity: 'Ada',
      mentionName: 'ada',
      runtime: 'pi',
      capabilityTags: [],
      maxConcurrentTasks: 1,
      command: 'pi',
      args: [],
      model: '',
      env: {},
    })
    expect(repositories.getChannel(fixture.summitId)?.memberAgentIds).toContain(createdAgent.id)
    expect(database.database.prepare(
      'SELECT 1 FROM channel_agent_memberships WHERE channel_id = ? AND agent_id = ?',
    ).get(fixture.summitId, createdAgent.id)).toBeUndefined()
  })

  it('migrates version 14 without losing messages and enables conversation persistence', async () => {
    const databasePath = await createDatabasePath()
    const fixture = createVersion14Fixture(databasePath)

    database = createSqliteDatabase(databasePath)
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const turn = repositories.createConversationTurn({
      channelId: fixture.channelId,
      triggerMessageId: fixture.messageId,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })
    repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: fixture.agentId,
      source: 'responsibility',
      rank: 0,
      matcherScore: 18,
    })
    repositories.upsertConversationSession({
      key: `${fixture.channelId}:timeline:${fixture.agentId}`,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agentId,
      runtime: 'pi',
      runtimeSessionId: 'session-1',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: fixture.messageId,
    })

    expect(repositories.getMessage(fixture.messageId)?.body).toBe('Legacy message')
    expect(repositories.getConversationTurn(turn.id)?.status).toBe('screening')
    expect(repositories.listTurnParticipants(turn.id)).toHaveLength(1)
    expect(repositories.getConversationSession(`${fixture.channelId}:timeline:${fixture.agentId}`)?.runtimeSessionId)
      .toBe('session-1')
    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 15').get())
      .toMatchObject({ version: 15 })
  })

  it('persists a rejected raw Handoff target without an Agent FK and updates valid Handoffs to terminal status', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createAgent({
      identity: 'Source', mentionName: 'source', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const target = repositories.createAgent({
      identity: 'Target', mentionName: 'target', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Please delegate.',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id, triggerMessageId: message.id, threadRootMessageId: null, mode: 'ordinary', maxRounds: 3,
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id, agentId: source.id, kind: 'response', priority: 'human_ordinary', round: 1,
      idempotencyKey: `${turn.id}:source`, sourceInvocationId: null,
    })

    const rejected = repositories.createConversationHandoff({
      turnId: turn.id,
      sourceInvocationId: invocation.id,
      fromAgentId: source.id,
      requestedTargetAgentId: 'missing-agent-id',
      toAgentId: null,
      question: 'Can you check this?',
      round: 2,
      status: 'rejected',
      reason: 'target_not_channel_member',
    })
    const accepted = repositories.createConversationHandoff({
      turnId: turn.id,
      sourceInvocationId: invocation.id,
      fromAgentId: source.id,
      requestedTargetAgentId: target.id,
      toAgentId: target.id,
      question: 'Can you check this?',
      round: 2,
      status: 'accepted',
    })

    expect(rejected).toMatchObject({ requestedTargetAgentId: 'missing-agent-id', toAgentId: null })
    expect(repositories.updateConversationHandoff(accepted.id, { status: 'completed', reason: null }))
      .toMatchObject({ status: 'completed', toAgentId: target.id })
    expect(repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ id: rejected.id, requestedTargetAgentId: 'missing-agent-id', toAgentId: null }),
      expect.objectContaining({ id: accepted.id, status: 'completed' }),
    ])
    expect(database!.database.prepare('SELECT version FROM schema_migrations WHERE version = 16').get())
      .toMatchObject({ version: 16 })
  })

  it('safely upgrades an existing migration 15 database and preserves conversation rows', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createAgent({
      identity: 'Legacy Source', mentionName: 'legacy-source', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const target = repositories.createAgent({
      identity: 'Legacy Target', mentionName: 'legacy-target', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Legacy turn.',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id, triggerMessageId: message.id, threadRootMessageId: null, mode: 'ordinary', maxRounds: 3,
    })
    repositories.createTurnParticipant({
      turnId: turn.id, agentId: source.id, source: 'responsibility', rank: 1, matcherScore: 1,
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id, agentId: source.id, kind: 'response', priority: 'human_ordinary', round: 1,
      idempotencyKey: `${turn.id}:legacy`, sourceInvocationId: null,
    })
    const handoff = repositories.createConversationHandoff({
      turnId: turn.id, sourceInvocationId: invocation.id, fromAgentId: source.id,
      requestedTargetAgentId: target.id, toAgentId: target.id, question: 'Continue.', round: 2, status: 'accepted',
    })
    database!.close()
    database = undefined
    downgradeConversationTablesToVersion15(databasePath)

    database = createSqliteDatabase(databasePath)
    const upgraded = new SqliteRepositories(database, new RecordingPublisher())

    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 16').get())
      .toEqual({ version: 16 })
    expect(upgraded.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ id: handoff.id, requestedTargetAgentId: target.id, toAgentId: target.id, status: 'accepted' }),
    ])
    expect(upgraded.updateTurnParticipant(turn.id, source.id, { status: 'cancelled' }).status).toBe('cancelled')
    expect(upgraded.updateConversationHandoff(handoff.id, { status: 'failed', reason: 'legacy_failed' }))
      .toMatchObject({ status: 'failed', reason: 'legacy_failed' })
  })

  it('upgrades an existing migration 16 database so partial Turn status is persisted and constrained', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createAgent({
      identity: 'Source', mentionName: 'source', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const target = repositories.createAgent({
      identity: 'Target', mentionName: 'target', runtime: 'opencode', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Legacy parallel Turn.',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id, triggerMessageId: message.id, threadRootMessageId: null,
      mode: 'multi_direct', maxRounds: 3,
    })
    const participant = repositories.createTurnParticipant({
      turnId: turn.id, agentId: source.id, source: 'direct', rank: 1, matcherScore: null,
      decision: 'speak', speakingOrder: 1, status: 'spoken', reason: 'legacy_participant',
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id, agentId: source.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:legacy-response`, sourceInvocationId: null, status: 'settled',
      startedAt: '2026-07-31T00:00:00.000Z', completedAt: '2026-07-31T00:00:01.000Z',
    })
    const handoff = repositories.createConversationHandoff({
      turnId: turn.id, sourceInvocationId: invocation.id, fromAgentId: source.id,
      requestedTargetAgentId: target.id, toAgentId: target.id, question: 'Legacy handoff.',
      round: 2, status: 'rejected', reason: 'parallel_handoff_disabled',
    })
    database!.close()
    database = undefined
    downgradeConversationTurnsToVersion16(databasePath)

    database = createSqliteDatabase(databasePath)
    const upgraded = new SqliteRepositories(database, new RecordingPublisher())

    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 17').get())
      .toEqual({ version: 17 })
    expect(upgraded.getConversationTurn(turn.id)).toMatchObject({ status: 'screening' })
    expect(upgraded.listTurnParticipants(turn.id)).toEqual([expect.objectContaining({
      id: participant.id, agentId: source.id, status: 'spoken', reason: 'legacy_participant',
    })])
    expect(upgraded.listAgentInvocations(turn.id)).toEqual([expect.objectContaining({
      id: invocation.id, agentId: source.id, status: 'settled', sourceInvocationId: null,
    })])
    expect(upgraded.listConversationHandoffs(turn.id)).toEqual([expect.objectContaining({
      id: handoff.id, sourceInvocationId: invocation.id, fromAgentId: source.id,
      toAgentId: target.id, status: 'rejected', reason: 'parallel_handoff_disabled',
    })])
    expect(upgraded.updateConversationTurn(turn.id, { status: 'partial' }).status).toBe('partial')
    expect(() => database!.database.prepare('UPDATE conversation_turns SET status = ? WHERE id = ?')
      .run('invalid-status', turn.id)).toThrow(/CHECK constraint failed/)
    expect(database.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'conversation_turns_status_created_at_idx'
    `).get()).toEqual({ name: 'conversation_turns_status_created_at_idx' })
    expect(database.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('restores the conversation session grain index for an already-migrated version 15 database', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Timeline message.',
    })
    const sessionInput = {
      channelId: channel.id,
      threadRootMessageId: null,
      agentId: agent.id,
      runtime: 'pi' as const,
      runtimeSessionId: 'session-1',
      runtimeSessionFile: null,
      status: 'ready' as const,
      lastMessageId: message.id,
    }
    repositories.upsertConversationSession({ key: 'timeline-key-1', ...sessionInput })
    expect(database!.database.prepare('SELECT version FROM schema_migrations WHERE version = 15').get())
      .toMatchObject({ version: 15 })

    database!.database.exec('DROP INDEX conversation_sessions_grain_unique_idx')
    database!.close()
    database = undefined
    database = createSqliteDatabase(databasePath)
    const reopenedRepositories = new SqliteRepositories(database, new RecordingPublisher())

    expect(database.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'conversation_sessions_grain_unique_idx'
    `).get()).toEqual({ name: 'conversation_sessions_grain_unique_idx' })
    expect(() => reopenedRepositories.upsertConversationSession({ key: 'timeline-key-2', ...sessionInput }))
      .toThrow(/UNIQUE constraint failed/)
  })

  it('rolls back migration 14 when version 13 has normalized duplicate Agent mentions', async () => {
    const databasePath = await createDatabasePath()
    createVersion13Fixture(databasePath, { duplicateNormalizedMention: true })

    expect(() => createSqliteDatabase(databasePath)).toThrow('Migration 14 cannot globalize duplicate Agent mention @legacy.')

    const legacy = new DatabaseSync(databasePath)
    expect(legacy.prepare('SELECT version FROM schema_migrations WHERE version = 14').get()).toBeUndefined()
    expect((legacy.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map((column) => column.name)).not.toContain('system_key')
    expect(() => legacy.prepare('SELECT * FROM channel_agent_memberships').all()).toThrow(/no such table/)
    legacy.close()
  })

  async function createRepositories(): Promise<{
    repositories: SqliteRepositories
    publisher: RecordingPublisher
    databasePath: string
  }> {
    const databasePath = await createDatabasePath()
    database = createSqliteDatabase(databasePath)
    const publisher = new RecordingPublisher()

    return {
      repositories: new SqliteRepositories(database, publisher),
      publisher,
      databasePath,
    }
  }

  async function createDatabasePath(): Promise<string> {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-'))
    return path.join(temporaryDirectory, 'sinapsis.sqlite')
  }

  function createChannel(repositories: SqliteRepositories) {
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({
      workspaceId: workspace.id,
      name: 'control-room',
      path: '/projects/control-room',
    })

    return repositories.createChannel({ name: 'engineering' })
  }

  function createVersion13Fixture(databasePath: string, options: { duplicateNormalizedMention?: boolean } = {}) {
    const legacy = new DatabaseSync(databasePath)
    const createdAt = '2026-07-29T00:00:00.000Z'
    const fixture = {
      workspaceId: 'workspace-v13',
      repositoryId: 'repository-v13',
      summitId: 'channel-summit-v13',
      ordinaryChannelId: 'channel-engineering-v13',
      agentId: 'agent-v13',
      taskId: 'task-v13',
    }

    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, lease_ttl_ms INTEGER NOT NULL DEFAULT 30000 CHECK(lease_ttl_ms > 0));
      CREATE TABLE repositories (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, current_branch TEXT NOT NULL DEFAULT '', default_branch TEXT NOT NULL DEFAULT '', is_clean INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE channels (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), name TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT, context_reset_at TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), mention_name TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL, capability_tags_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, identity TEXT NOT NULL DEFAULT '', max_concurrent_tasks INTEGER NOT NULL DEFAULT 1, command TEXT NOT NULL DEFAULT '', args_json TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}', responsibilities_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), channel_id TEXT NOT NULL REFERENCES channels(id), direct_agent_id TEXT REFERENCES agents(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, labels_json TEXT NOT NULL, status TEXT NOT NULL, queued_at TEXT NOT NULL, attempt_count INTEGER NOT NULL, max_retries INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, branch_name TEXT, worktree_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_ttl_ms INTEGER CHECK(lease_ttl_ms IS NULL OR lease_ttl_ms > 0), thread_root_message_id TEXT);
      CREATE TABLE channel_agent_subscriptions (channel_id TEXT NOT NULL REFERENCES channels(id), agent_id TEXT NOT NULL REFERENCES agents(id), created_at TEXT NOT NULL, PRIMARY KEY (channel_id, agent_id));
      CREATE UNIQUE INDEX agents_workspace_mention_unique_idx ON agents(workspace_id, mention_name);
      CREATE UNIQUE INDEX channels_active_normalized_name_unique_idx ON channels(lower(trim(name))) WHERE archived_at IS NULL;
    `)
    const insertMigration = legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (let version = 1; version <= 13; version += 1) insertMigration.run(version, createdAt)
    legacy.prepare('INSERT INTO workspaces (id, name, lease_ttl_ms, created_at) VALUES (?, ?, ?, ?)').run(fixture.workspaceId, 'Legacy workspace', 30000, createdAt)
    legacy.prepare('INSERT INTO repositories (id, workspace_id, name, path, current_branch, default_branch, is_clean, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      fixture.repositoryId, fixture.workspaceId, 'Legacy repository', '/projects/legacy', 'main', 'main', 1, createdAt,
    )
    legacy.prepare('INSERT INTO channels (id, repository_id, name, archived_at, context_reset_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      fixture.summitId, fixture.repositoryId, 'summit', null, null, createdAt,
    )
    legacy.prepare('INSERT INTO channels (id, repository_id, name, archived_at, context_reset_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      fixture.ordinaryChannelId, fixture.repositoryId, 'engineering', null, null, createdAt,
    )
    legacy.prepare(`
      INSERT INTO agents (id, workspace_id, identity, mention_name, runtime, status, capability_tags_json, responsibilities_json, max_concurrent_tasks, command, args_json, model, env_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fixture.agentId, fixture.workspaceId, 'Legacy agent', 'legacy', 'pi', 'idle', '[]', '[]', 1, 'pi', '[]', '', '{}', createdAt, createdAt)
    if (options.duplicateNormalizedMention) {
      legacy.prepare('INSERT INTO workspaces (id, name, lease_ttl_ms, created_at) VALUES (?, ?, ?, ?)').run('workspace-v13-duplicate', 'Duplicate workspace', 30000, createdAt)
      legacy.prepare(`
        INSERT INTO agents (id, workspace_id, identity, mention_name, runtime, status, capability_tags_json, responsibilities_json, max_concurrent_tasks, command, args_json, model, env_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('agent-v13-duplicate', 'workspace-v13-duplicate', 'Duplicate agent', ' Legacy ', 'pi', 'idle', '[]', '[]', 1, 'pi', '[]', '', '{}', createdAt, createdAt)
    }
    legacy.prepare('INSERT INTO channel_agent_subscriptions (channel_id, agent_id, created_at) VALUES (?, ?, ?)').run(fixture.summitId, fixture.agentId, createdAt)
    legacy.prepare('INSERT INTO channel_agent_subscriptions (channel_id, agent_id, created_at) VALUES (?, ?, ?)').run(fixture.ordinaryChannelId, fixture.agentId, createdAt)
    legacy.prepare(`
      INSERT INTO tasks (id, repository_id, channel_id, direct_agent_id, title, description, acceptance_criteria, labels_json, status, queued_at, attempt_count, max_retries, timeout_ms, lease_ttl_ms, branch_name, worktree_path, created_at, updated_at, thread_root_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fixture.taskId, fixture.repositoryId, fixture.ordinaryChannelId, null, 'Legacy task', 'Description', 'Done', '[]', 'queued', createdAt, 0, 2, 900000, null, null, null, createdAt, createdAt, null)
    legacy.close()
    return fixture
  }

  function downgradeConversationTablesToVersion15(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE turn_participants RENAME TO turn_participants_v16;
      CREATE TABLE turn_participants (
        id TEXT NOT NULL UNIQUE,
        turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        source TEXT NOT NULL CHECK(source IN ('responsibility', 'direct', 'all', 'handoff')),
        rank INTEGER NOT NULL CHECK(rank >= 0),
        matcher_score REAL,
        decision TEXT NOT NULL CHECK(decision IN ('pending', 'speak', 'silent', 'skipped')),
        confidence REAL,
        proposed_angle TEXT,
        depends_on_agent_id TEXT REFERENCES agents(id),
        speaking_order INTEGER CHECK(speaking_order IS NULL OR speaking_order >= 0),
        status TEXT NOT NULL CHECK(status IN ('candidate', 'selected', 'spoken', 'failed', 'skipped')),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (turn_id, agent_id)
      );
      INSERT INTO turn_participants SELECT * FROM turn_participants_v16;
      DROP TABLE turn_participants_v16;

      ALTER TABLE conversation_handoffs RENAME TO conversation_handoffs_v16;
      CREATE TABLE conversation_handoffs (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
        source_invocation_id TEXT NOT NULL REFERENCES agent_invocations(id),
        from_agent_id TEXT NOT NULL REFERENCES agents(id),
        to_agent_id TEXT NOT NULL REFERENCES agents(id),
        question TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round >= 0),
        status TEXT NOT NULL CHECK(status IN ('queued', 'accepted', 'rejected', 'completed')),
        reason TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO conversation_handoffs (
        id, turn_id, source_invocation_id, from_agent_id, to_agent_id,
        question, round, status, reason, created_at
      ) SELECT id, turn_id, source_invocation_id, from_agent_id, to_agent_id,
        question, round, status, reason, created_at
      FROM conversation_handoffs_v16;
      DROP TABLE conversation_handoffs_v16;
      DELETE FROM schema_migrations WHERE version = 16;
      COMMIT;
    `)
    legacy.close()
  }

  function downgradeConversationTurnsToVersion16(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE conversation_turns_v16 (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        trigger_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        thread_root_message_id TEXT REFERENCES messages(id),
        mode TEXT NOT NULL CHECK(mode IN ('ordinary', 'direct', 'multi_direct', 'all')),
        status TEXT NOT NULL CHECK(status IN ('screening', 'judging', 'responding', 'handoff', 'completed', 'cancelled', 'failed')),
        current_round INTEGER NOT NULL CHECK(current_round >= 0),
        max_rounds INTEGER NOT NULL CHECK(max_rounds > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO conversation_turns_v16 SELECT * FROM conversation_turns;
      DROP TABLE conversation_turns;
      ALTER TABLE conversation_turns_v16 RENAME TO conversation_turns;
      CREATE INDEX conversation_turns_status_created_at_idx ON conversation_turns(status, created_at);
      DELETE FROM schema_migrations WHERE version = 17;
      COMMIT;
    `)
    legacy.close()
  }

  function createVersion14Fixture(databasePath: string) {
    const legacy = new DatabaseSync(databasePath)
    const createdAt = '2026-07-30T00:00:00.000Z'
    const fixture = {
      workspaceId: 'workspace-v14',
      repositoryId: 'repository-v14',
      channelId: 'channel-v14',
      agentId: 'agent-v14',
      messageId: 'message-v14',
    }

    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, lease_ttl_ms INTEGER NOT NULL DEFAULT 30000 CHECK(lease_ttl_ms > 0));
      CREATE TABLE repositories (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, current_branch TEXT NOT NULL DEFAULT '', default_branch TEXT NOT NULL DEFAULT '', is_clean INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE channels (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), name TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT, context_reset_at TEXT, system_key TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), mention_name TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL, capability_tags_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, identity TEXT NOT NULL DEFAULT '', max_concurrent_tasks INTEGER NOT NULL DEFAULT 1, command TEXT NOT NULL DEFAULT '', args_json TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}', responsibilities_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), channel_id TEXT NOT NULL REFERENCES channels(id), direct_agent_id TEXT REFERENCES agents(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, labels_json TEXT NOT NULL, status TEXT NOT NULL, queued_at TEXT NOT NULL, attempt_count INTEGER NOT NULL, max_retries INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, branch_name TEXT, worktree_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_ttl_ms INTEGER CHECK(lease_ttl_ms IS NULL OR lease_ttl_ms > 0), thread_root_message_id TEXT REFERENCES messages(id), workspace_id TEXT REFERENCES workspaces(id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), task_id TEXT REFERENCES tasks(id), sender_type TEXT NOT NULL, sender_id TEXT, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, thread_root_id TEXT REFERENCES messages(id));
      CREATE TABLE channel_agent_subscriptions (channel_id TEXT NOT NULL REFERENCES channels(id), agent_id TEXT NOT NULL REFERENCES agents(id), created_at TEXT NOT NULL, PRIMARY KEY (channel_id, agent_id));
      CREATE TABLE channel_agent_memberships (channel_id TEXT NOT NULL REFERENCES channels(id), agent_id TEXT NOT NULL REFERENCES agents(id), created_at TEXT NOT NULL, PRIMARY KEY (channel_id, agent_id));
      CREATE TABLE channel_workspace_bindings (channel_id TEXT NOT NULL REFERENCES channels(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), created_at TEXT NOT NULL, PRIMARY KEY (channel_id, workspace_id));
    `)
    const insertMigration = legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (let version = 1; version <= 14; version += 1) insertMigration.run(version, createdAt)
    legacy.prepare('INSERT INTO workspaces (id, name, lease_ttl_ms, created_at) VALUES (?, ?, ?, ?)').run(
      fixture.workspaceId, 'Legacy workspace', 30000, createdAt,
    )
    legacy.prepare('INSERT INTO repositories (id, workspace_id, name, path, current_branch, default_branch, is_clean, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      fixture.repositoryId, fixture.workspaceId, 'Legacy repository', '/projects/legacy', 'main', 'main', 1, createdAt,
    )
    legacy.prepare('INSERT INTO channels (id, repository_id, name, system_key, archived_at, context_reset_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      fixture.channelId, fixture.repositoryId, 'engineering', null, null, null, createdAt,
    )
    legacy.prepare(`
      INSERT INTO agents (id, workspace_id, identity, mention_name, runtime, status, capability_tags_json, responsibilities_json, max_concurrent_tasks, command, args_json, model, env_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fixture.agentId, fixture.workspaceId, 'Legacy agent', 'legacy', 'pi', 'idle', '[]', '[]', 1, 'pi', '[]', '', '{}', createdAt, createdAt)
    legacy.prepare(`
      INSERT INTO messages (id, channel_id, thread_root_id, task_id, sender_type, sender_id, author_name, body, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fixture.messageId, fixture.channelId, null, null, 'human', null, 'Jodu', 'Legacy message', createdAt, createdAt, null)
    legacy.close()
    return fixture
  }
})
