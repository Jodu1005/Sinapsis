import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../app'
import { DomainError, transitionTask, type Task } from '../../domain/task'
import type { DomainEvent } from '../../domain/events'
import type { DomainEventPublisher } from '../../ports/domain-event-publisher'
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
    expect(repositories.getBootstrap().workspaces[0]?.recentMessages).toEqual([])
  })

  it('rejects moving an accepted task back to queued', () => {
    const acceptedTask: Task = {
      id: 'task-1',
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
    const task = repositories.createTask({
      repositoryId: channel.repositoryId,
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

  it('returns an empty bootstrap snapshot for a new database', async () => {
    const databasePath = await createDatabasePath()
    const app = createApp({ databasePath })
    const server = await startHttpTestServer(app)

    try {
      const response = await fetch(`${server.baseUrl}/api/bootstrap`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ workspaces: [] })
    } finally {
      await server.close()
      app.locals.closeDatabase()
    }
  })

  it('migrates legacy duplicate channel names without deleting channels and then enforces repository-local uniqueness', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    database!.database.exec('DROP INDEX channels_repository_name_unique_idx')
    database!.database.prepare('DELETE FROM schema_migrations WHERE version = 4').run()
    database!.database.prepare('INSERT INTO channels (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      'legacy-duplicate-channel', channel.repositoryId, channel.name, '2026-07-24T00:00:00.000Z',
    )
    database!.close()
    database = undefined
    database = createSqliteDatabase(databasePath)

    const channels = database.database.prepare('SELECT id, name FROM channels WHERE repository_id = ? ORDER BY created_at, id').all(channel.repositoryId)
    expect(channels).toEqual([
      { id: 'legacy-duplicate-channel', name: 'engineering' },
      expect.objectContaining({ name: 'engineering-2' }),
    ])
    expect(() => database!.database.prepare('INSERT INTO channels (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      'another-duplicate-channel', channel.repositoryId, 'engineering', '2026-07-25T00:00:00.000Z',
    )).toThrow('UNIQUE constraint failed: channels.repository_id, channels.name')
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
    const repository = repositories.createRepository({
      workspaceId: workspace.id,
      name: 'control-room',
      path: '/projects/control-room',
    })

    return repositories.createChannel({
      repositoryId: repository.id,
      name: 'engineering',
    })
  }
})
