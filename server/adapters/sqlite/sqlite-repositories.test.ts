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
})
