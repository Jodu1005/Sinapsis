import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../app'
import { ChannelTurnCoordinator } from '../../application/channel-turn-coordinator'
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

  it('persists Dream runs, candidates, and their channel message sources', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Frontend uses React.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual',
      from: null, to: { createdAt: message.createdAt, id: message.id },
    })
    const candidate = repositories.createMemoryCandidate({
      dreamRunId: run.id,
      proposedScope: 'channel',
      channelId: channel.id,
      kind: 'fact',
      proposedContent: 'Frontend uses React.',
      rationale: 'Repeated discussions confirm this.',
      confidence: 0.92,
      importance: 0.8,
      sourceMessageIds: [message.id],
    })

    expect(repositories.getDreamRun(run.id)).toMatchObject({
      id: run.id, status: 'queued', candidateCount: 1,
      toMessageCreatedAt: message.createdAt, toMessageId: message.id,
    })
    expect(repositories.listMemoryCandidates({ status: 'pending' })).toEqual([
      expect.objectContaining({ id: candidate.id, dreamRunId: run.id, channelId: channel.id }),
    ])
    expect(repositories.listDreamSourceMessages(run.id).map((item) => item.id)).toEqual([message.id])
  })

  it('rolls back every candidate and the run count when a candidate batch fails', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Frontend uses React.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual',
      from: null, to: { createdAt: message.createdAt, id: message.id },
    })
    const input = {
      dreamRunId: run.id, proposedScope: 'channel' as const, channelId: channel.id, kind: 'fact' as const,
      proposedContent: 'Frontend uses React.', rationale: 'Confirmed.', confidence: 0.9, importance: 0.8,
      sourceMessageIds: [message.id],
    }

    expect(() => repositories.createMemoryCandidates([input, input])).toThrow(/UNIQUE constraint failed/)

    expect(repositories.listMemoryCandidates({ dreamRunId: run.id })).toEqual([])
    expect(repositories.getDreamRun(run.id)?.candidateCount).toBe(0)
  })

  it('persists a Thread Summary with an ordered message watermark', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const root = repositories.createMessage({ channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Root' })
    const reply = repositories.createMessage({
      channelId: channel.id, threadRootMessageId: root.id, senderType: 'agent', authorName: 'Ada', body: 'Reply',
    })

    const saved = repositories.upsertThreadSummary({
      channelId: channel.id,
      threadRootMessageId: root.id,
      content: 'Summary through reply.',
      throughMessageCreatedAt: reply.createdAt,
      throughMessageId: reply.id,
    })

    expect(repositories.getThreadSummary(channel.id, root.id)).toEqual(saved)
    expect(saved).toMatchObject({
      content: 'Summary through reply.', throughMessageCreatedAt: reply.createdAt, throughMessageId: reply.id,
    })
  })

  it('does not move a Thread Summary watermark backward or overwrite the same watermark', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const root = repositories.createMessage({ channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Root' })
    const earlier = repositories.createMessage({
      channelId: channel.id, threadRootMessageId: root.id, senderType: 'agent', authorName: 'Ada', body: 'Earlier',
    })
    const later = repositories.createMessage({
      channelId: channel.id, threadRootMessageId: root.id, senderType: 'agent', authorName: 'Ada', body: 'Later',
    })
    database!.database.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run('2026-08-02T08:00:00.000Z', root.id)
    database!.database.prepare('UPDATE messages SET created_at = ? WHERE id IN (?, ?)')
      .run('2026-08-02T08:01:00.000Z', earlier.id, later.id)

    const newest = repositories.upsertThreadSummary({
      channelId: channel.id, threadRootMessageId: root.id, content: 'Newest summary.',
      throughMessageCreatedAt: '2026-08-02T08:01:00.000Z', throughMessageId: later.id,
    })
    const staleResult = repositories.upsertThreadSummary({
      channelId: channel.id, threadRootMessageId: root.id, content: 'Stale summary.',
      throughMessageCreatedAt: '2026-08-02T08:01:00.000Z', throughMessageId: earlier.id,
    })
    const equalResult = repositories.upsertThreadSummary({
      channelId: channel.id, threadRootMessageId: root.id, content: 'Same watermark replacement.',
      throughMessageCreatedAt: '2026-08-02T08:01:00.000Z', throughMessageId: later.id,
    })

    expect(staleResult).toEqual(newest)
    expect(equalResult).toEqual(newest)
    expect(repositories.getThreadSummary(channel.id, root.id)).toEqual(newest)
  })

  it('lists public Thread messages after a soft-deleted watermark by persisted stable order', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const root = repositories.createMessage({ channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Root' })
    const watermark = repositories.createMessage({
      channelId: channel.id, threadRootMessageId: root.id, senderType: 'human', authorName: 'Jodu', body: 'Watermark',
    })
    const after = repositories.createMessage({
      channelId: channel.id, threadRootMessageId: root.id, senderType: 'human', authorName: 'Jodu', body: 'After',
    })
    database!.database.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run('2026-08-02T08:00:00.000Z', root.id)
    database!.database.prepare('UPDATE messages SET id = ?, created_at = ? WHERE id = ?')
      .run('z-deleted-watermark', '2026-08-02T08:01:00.000Z', watermark.id)
    database!.database.prepare('UPDATE messages SET id = ?, created_at = ? WHERE id = ?')
      .run('a-after-watermark', '2026-08-02T08:01:00.000Z', after.id)
    repositories.deleteMessage('z-deleted-watermark')

    expect(repositories.listMessagesAfterThreadWatermark(
      channel.id, root.id, 'z-deleted-watermark',
    ).map((message) => message.id)).toEqual(['a-after-watermark'])
  })

  it('enforces channel scope and source channel constraints in SQLite', async () => {
    const { repositories } = await createRepositories()
    const firstChannel = createChannel(repositories)
    const secondWorkspace = repositories.createWorkspace({ name: 'Second' })
    repositories.createRepository({ workspaceId: secondWorkspace.id, name: 'second-repository', path: '/projects/second' })
    const secondChannel = repositories.createChannel({ name: 'operations' })
    const source = repositories.createMessage({
      channelId: firstChannel.id, senderType: 'human', authorName: 'Jodu', body: 'A source message.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: secondChannel.id, trigger: 'manual', from: null, to: null,
    })

    expect(() => repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: null, kind: 'fact',
      proposedContent: 'Channel-specific fact.', rationale: 'Test.', confidence: 0.9, importance: 0.5,
      sourceMessageIds: [],
    })).toThrow(/channel/i)
    expect(() => repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: secondChannel.id, kind: 'fact',
      proposedContent: 'Wrong source channel.', rationale: 'Test.', confidence: 0.9, importance: 0.5,
      sourceMessageIds: [source.id],
    })).toThrow(/source|channel/i)
    expect(() => database!.database.prepare(`
      INSERT INTO memory_candidates (
        id, dream_run_id, proposed_scope, channel_id, kind, proposed_content, rationale, confidence,
        importance, content_hash, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'invalid-channel-candidate', run.id, 'channel', null, 'fact', 'Invalid.', 'Test.', 0.9,
      0.5, 'invalid', 'pending', '2026-08-02T00:00:00.000Z',
    )).toThrow(/CHECK constraint failed/)
    const validCandidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: secondChannel.id, kind: 'fact',
      proposedContent: 'Valid source constraint fixture.', rationale: 'Test.', confidence: 0.9, importance: 0.5,
      sourceMessageIds: [],
    })
    expect(() => database!.database.prepare(`
      INSERT INTO memory_candidate_sources (candidate_id, message_id, turn_id) VALUES (?, ?, ?)
    `).run(validCandidate.id, source.id, null)).toThrow(/Dream channel/)
  })

  it('accepts a candidate atomically, reuses matching Memory, inherits sources, and supersedes duplicates', async () => {
    const { repositories, publisher } = await createRepositories()
    const channel = createChannel(repositories)
    const firstSource = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Use React.',
    })
    const secondSource = repositories.createMessage({
      channelId: channel.id, senderType: 'agent', authorName: 'Ada', body: 'React is established.',
    })
    const thirdSource = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Use React for the frontend.',
    })
    const fourthSource = repositories.createMessage({
      channelId: channel.id, senderType: 'agent', authorName: 'Ada', body: 'React remains the frontend standard.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'scheduled', from: null,
      to: { createdAt: secondSource.createdAt, id: secondSource.id },
    })
    const first = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact',
      proposedContent: 'Frontend uses React.', rationale: 'Confirmed.', confidence: 0.9, importance: 0.7,
      sourceMessageIds: [firstSource.id, secondSource.id],
    })
    const duplicateRun = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'scheduled',
      from: { createdAt: secondSource.createdAt, id: secondSource.id },
      to: { createdAt: thirdSource.createdAt, id: thirdSource.id },
    })
    const duplicate = repositories.createMemoryCandidate({
      dreamRunId: duplicateRun.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact',
      proposedContent: 'Frontend uses React.', rationale: 'Same fact.', confidence: 0.8, importance: 0.6,
      sourceMessageIds: [secondSource.id],
    })

    const memory = repositories.createMemoryFromCandidate({
      candidateId: first.id, reviewedContent: 'Frontend uses React.', reviewedScope: 'channel',
      occurredAt: new Date('2026-08-02T00:00:00.000Z'),
    })

    expect(repositories.getMemoryCandidate(first.id)).toMatchObject({ status: 'accepted' })
    expect(repositories.getMemoryCandidate(duplicate.id)).toMatchObject({ status: 'superseded' })
    expect(repositories.listAcceptedMemories('channel', channel.id)).toEqual([
      expect.objectContaining({ id: memory.id, sourceCandidateId: first.id, content: 'Frontend uses React.' }),
    ])
    expect(database!.database.prepare(`
      SELECT message_id FROM memory_sources WHERE memory_id = ? ORDER BY message_id
    `).all(memory.id)).toEqual([
      { message_id: firstSource.id },
      { message_id: secondSource.id },
    ].sort((left, right) => left.message_id.localeCompare(right.message_id)))
    expect(publisher.events.map((item) => item.type)).toContain('memory.candidate_reviewed')
    expect(publisher.events.map((item) => item.type)).toContain('memory.changed')

    const reuseRun = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual',
      from: { createdAt: thirdSource.createdAt, id: thirdSource.id },
      to: { createdAt: fourthSource.createdAt, id: fourthSource.id },
    })
    const reusedCandidate = repositories.createMemoryCandidate({
      dreamRunId: reuseRun.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact',
      proposedContent: 'Frontend uses React.', rationale: 'Still confirmed.', confidence: 0.95, importance: 0.8,
      sourceMessageIds: [fourthSource.id],
    })
    const reusedMemory = repositories.createMemoryFromCandidate({
      candidateId: reusedCandidate.id, reviewedContent: 'Frontend uses React.', reviewedScope: 'channel',
      occurredAt: new Date('2026-08-02T00:01:00.000Z'),
    })

    expect(reusedMemory.id).toBe(memory.id)
    expect(repositories.getMemoryCandidate(reusedCandidate.id)).toMatchObject({ status: 'accepted' })
    expect(database!.database.prepare(`
      SELECT message_id FROM memory_sources WHERE memory_id = ? ORDER BY message_id
    `).all(memory.id)).toContainEqual({ message_id: fourthSource.id })
    expect(() => database!.database.prepare(`
      INSERT INTO memory_sources (memory_id, candidate_id, message_id, turn_id) VALUES (?, ?, ?, ?)
    `).run(memory.id, first.id, fourthSource.id, null)).toThrow(/candidate and Dream channel/)
  })

  it('uses the Dream channel when accepting a Global candidate as channel-scoped Memory', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Keep this channel-specific.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const candidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'global', channelId: null, kind: 'decision',
      proposedContent: 'Use React.', rationale: 'Accepted for this channel.', confidence: 0.9, importance: 0.8,
      sourceMessageIds: [source.id],
    })

    const memory = repositories.createMemoryFromCandidate({
      candidateId: candidate.id, reviewedContent: 'Use React.', reviewedScope: 'channel',
      occurredAt: new Date('2026-08-03T00:00:00.000Z'),
    })

    expect(memory).toMatchObject({ scope: 'channel', channelId: channel.id })
    expect(repositories.listAcceptedMemories('channel', channel.id)).toEqual([
      expect.objectContaining({ id: memory.id }),
    ])
    expect(repositories.listAcceptedMemories('global')).toEqual([])
  })

  it('reuses a Global Memory across Dream channels while retaining each candidate source provenance', async () => {
    const { repositories } = await createRepositories()
    const channelA = createChannel(repositories)
    const workspaceB = repositories.createWorkspace({ name: 'Second workspace' })
    repositories.createRepository({ workspaceId: workspaceB.id, name: 'second-repository', path: '/projects/second' })
    const channelB = repositories.createChannel({ name: 'operations' })
    const sourceA = repositories.createMessage({
      channelId: channelA.id, senderType: 'human', authorName: 'Jodu', body: 'React is the standard.',
    })
    const sourceB = repositories.createMessage({
      channelId: channelB.id, senderType: 'human', authorName: 'Jodu', body: 'Operations also use React.',
    })
    const candidateA = repositories.createMemoryCandidate({
      dreamRunId: repositories.createDreamRun({
        scope: 'channel', scopeId: channelA.id, trigger: 'manual', from: null,
        to: { createdAt: sourceA.createdAt, id: sourceA.id },
      }).id,
      proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'Frontend uses React.',
      rationale: 'Channel A confirmation.', confidence: 0.9, importance: 0.8, sourceMessageIds: [sourceA.id],
    })
    const memory = repositories.createMemoryFromCandidate({
      candidateId: candidateA.id, reviewedContent: 'Frontend uses React.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-03T00:00:00.000Z'),
    })
    const candidateB = repositories.createMemoryCandidate({
      dreamRunId: repositories.createDreamRun({
        scope: 'channel', scopeId: channelB.id, trigger: 'manual', from: null,
        to: { createdAt: sourceB.createdAt, id: sourceB.id },
      }).id,
      proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'Frontend uses React.',
      rationale: 'Channel B confirmation.', confidence: 0.9, importance: 0.8, sourceMessageIds: [sourceB.id],
    })

    const reused = repositories.createMemoryFromCandidate({
      candidateId: candidateB.id, reviewedContent: 'Frontend uses React.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-03T00:01:00.000Z'),
    })

    expect(reused.id).toBe(memory.id)
    expect(repositories.getMemoryCandidate(candidateB.id)).toMatchObject({ status: 'accepted' })
    expect(database!.database.prepare(`
      SELECT candidate_id, message_id FROM memory_sources WHERE memory_id = ? ORDER BY candidate_id
    `).all(memory.id)).toEqual([
      { candidate_id: candidateA.id, message_id: sourceA.id },
      { candidate_id: candidateB.id, message_id: sourceB.id },
    ].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)))
  })

  it('rejects duplicate no-watermark Dream runs for a channel', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)

    repositories.createDreamRun({ scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null, to: null })

    expect(() => repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'scheduled', from: null, to: null,
    })).toThrow(/UNIQUE constraint failed/)
  })

  it('prevents a second SQLite writer from accepting while the first holds BEGIN IMMEDIATE', async () => {
    const { repositories, publisher, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Concurrent review.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const candidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact',
      proposedContent: 'Concurrent Memory.', rationale: 'Test.', confidence: 0.9, importance: 0.8,
      sourceMessageIds: [source.id],
    })
    const secondDatabase = createSqliteDatabase(databasePath)
    const secondPublisher = new RecordingPublisher()
    const competing = new SqliteRepositories(secondDatabase, secondPublisher)

    try {
      const eventCount = publisher.events.length
      let memoryId = ''
      repositories.inTransaction(() => {
        memoryId = repositories.createMemoryFromCandidate({
          candidateId: candidate.id, reviewedContent: 'Concurrent Memory.', reviewedScope: 'channel',
          occurredAt: new Date('2026-08-03T00:00:00.000Z'),
        }).id

        expect(competing.getMemoryCandidate(candidate.id)).toMatchObject({ status: 'pending' })
        expect(() => competing.createMemoryFromCandidate({
          candidateId: candidate.id, reviewedContent: 'Concurrent Memory.', reviewedScope: 'channel',
          occurredAt: new Date('2026-08-03T00:00:01.000Z'),
        })).toThrow(/database is locked|SQLITE_BUSY/)
        expect(publisher.events).toHaveLength(eventCount)
        expect(secondPublisher.events).toEqual([])
      })

      expect(repositories.getMemoryCandidate(candidate.id)).toMatchObject({ status: 'accepted' })
      expect(database!.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 })
      expect(database!.database.prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?').get(memoryId))
        .toEqual({ count: 1 })
      expect(secondPublisher.events).toEqual([])
      expect(publisher.events.map((event) => event.type)).toContain('memory.changed')
    } finally {
      secondDatabase.close()
    }
  })

  it('rolls back a failed candidate acceptance without leaking Memory events', async () => {
    const { repositories, publisher } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Rollback review.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const candidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact',
      proposedContent: 'Rollback Memory.', rationale: 'Test.', confidence: 0.9, importance: 0.8,
      sourceMessageIds: [source.id],
    })
    const eventCount = publisher.events.length

    expect(() => repositories.inTransaction(() => {
      repositories.createMemoryFromCandidate({
        candidateId: candidate.id, reviewedContent: 'Rollback Memory.', reviewedScope: 'channel',
        occurredAt: new Date('2026-08-03T00:00:00.000Z'),
      })
      throw new Error('force review rollback')
    })).toThrow('force review rollback')

    expect(repositories.getMemoryCandidate(candidate.id)).toMatchObject({ status: 'pending' })
    expect(database!.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 })
    expect(database!.database.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 })
    expect(publisher.events).toHaveLength(eventCount)
  })

  it('upgrades an existing migration 18 database through migration 21', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Existing data survives.',
    })
    database!.close()
    database = undefined
    downgradeDreamMemoryToVersion18(databasePath)

    database = createSqliteDatabase(databasePath)

    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 20').get())
      .toEqual({ version: 20 })
    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 21').get())
      .toEqual({ version: 21 })
    expect((database.database.prepare('PRAGMA table_info(memory_sources)').all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain('candidate_id')
    expect(database.database.prepare('SELECT id FROM messages WHERE id = ?').get(message.id))
      .toEqual({ id: message.id })
  })

  it('upgrades migration 20 Thread Summaries with empty watermarks without losing content', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const root = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Legacy Thread root.',
    })
    database!.database.prepare(`
      INSERT INTO thread_summaries (channel_id, thread_root_message_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(channel.id, root.id, 'Legacy summary.', root.createdAt, root.updatedAt)
    database!.close()
    database = undefined
    downgradeThreadSummariesToVersion20(databasePath)

    database = createSqliteDatabase(databasePath)
    const upgraded = new SqliteRepositories(database, new RecordingPublisher())

    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 21').get())
      .toEqual({ version: 21 })
    expect(upgraded.getThreadSummary(channel.id, root.id)).toMatchObject({
      content: 'Legacy summary.', throughMessageCreatedAt: null, throughMessageId: null,
    })
  })

  it('upgrades migration 21 with database constraints requiring paired Summary watermark columns', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const root = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Thread root.',
    })
    database!.close()
    database = undefined
    downgradeThreadSummaryConstraintsToVersion21(databasePath)
    const version21 = new DatabaseSync(databasePath)
    version21.prepare(`
      INSERT INTO thread_summaries (
        channel_id, thread_root_message_id, content, through_message_created_at, through_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)
    `).run(
      channel.id, root.id, 'Legacy half-watermark summary.', root.createdAt, root.createdAt, root.updatedAt,
    )
    version21.close()

    database = createSqliteDatabase(databasePath)
    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 22').get())
      .toEqual({ version: 22 })
    expect(new SqliteRepositories(database, new RecordingPublisher()).getThreadSummary(channel.id, root.id)).toMatchObject({
      content: 'Legacy half-watermark summary.',
      throughMessageCreatedAt: null,
      throughMessageId: null,
    })
    expect(() => database!.database.prepare(`
      UPDATE thread_summaries SET through_message_id = ? WHERE channel_id = ? AND thread_root_message_id = ?
    `).run(root.id, channel.id, root.id)).toThrow(/watermark/i)
  })

  it('upgrades original migration 19 Dream sources without losing provenance and supports later Global reuse', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channelA = createChannel(repositories)
    const sourceA = repositories.createMessage({
      channelId: channelA.id, senderType: 'human', authorName: 'Jodu', body: 'Original 19 source.',
    })
    const candidateA = repositories.createMemoryCandidate({
      dreamRunId: repositories.createDreamRun({
        scope: 'channel', scopeId: channelA.id, trigger: 'manual', from: null,
        to: { createdAt: sourceA.createdAt, id: sourceA.id },
      }).id,
      proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'All teams use React.',
      rationale: 'Original migration data.', confidence: 0.9, importance: 0.8, sourceMessageIds: [sourceA.id],
    })
    const memory = repositories.createMemoryFromCandidate({
      candidateId: candidateA.id, reviewedContent: 'All teams use React.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-04T00:00:00.000Z'),
    })
    database!.close()
    database = undefined
    restoreOriginalMigration19Schema(databasePath)

    database = createSqliteDatabase(databasePath)
    const upgraded = new SqliteRepositories(database, new RecordingPublisher())

    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 20').get())
      .toEqual({ version: 20 })
    expect(database.database.prepare(`
      SELECT candidate_id, message_id FROM memory_sources WHERE memory_id = ?
    `).all(memory.id)).toEqual([{ candidate_id: candidateA.id, message_id: sourceA.id }])
    upgraded.createDreamRun({ scope: 'channel', scopeId: channelA.id, trigger: 'manual', from: null, to: null })
    expect(() => upgraded.createDreamRun({
      scope: 'channel', scopeId: channelA.id, trigger: 'scheduled', from: null, to: null,
    })).toThrow(/UNIQUE constraint failed/)

    const workspaceB = upgraded.createWorkspace({ name: 'Post-upgrade workspace' })
    upgraded.createRepository({ workspaceId: workspaceB.id, name: 'post-upgrade-repository', path: '/projects/post-upgrade' })
    const channelB = upgraded.createChannel({ name: 'operations' })
    const sourceB = upgraded.createMessage({
      channelId: channelB.id, senderType: 'human', authorName: 'Jodu', body: 'Post-upgrade source.',
    })
    const candidateB = upgraded.createMemoryCandidate({
      dreamRunId: upgraded.createDreamRun({
        scope: 'channel', scopeId: channelB.id, trigger: 'manual', from: null,
        to: { createdAt: sourceB.createdAt, id: sourceB.id },
      }).id,
      proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'All teams use React.',
      rationale: 'Post-upgrade reuse.', confidence: 0.9, importance: 0.8, sourceMessageIds: [sourceB.id],
    })
    const reused = upgraded.createMemoryFromCandidate({
      candidateId: candidateB.id, reviewedContent: 'All teams use React.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-04T00:01:00.000Z'),
    })

    expect(reused.id).toBe(memory.id)
    expect(database.database.prepare(`
      SELECT candidate_id, message_id FROM memory_sources WHERE memory_id = ? ORDER BY candidate_id
    `).all(memory.id)).toEqual([
      { candidate_id: candidateA.id, message_id: sourceA.id },
      { candidate_id: candidateB.id, message_id: sourceB.id },
    ].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)))
  })

  it('restores original migration 19 sources without crossing Global and channel Memory provenance', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Shared source.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const globalCandidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'Shared fact.',
      rationale: 'Global.', confidence: 0.9, importance: 0.8, sourceMessageIds: [source.id],
    })
    const channelCandidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact', proposedContent: 'Shared fact.',
      rationale: 'Channel.', confidence: 0.9, importance: 0.8, sourceMessageIds: [source.id],
    })
    const globalMemory = repositories.createMemoryFromCandidate({
      candidateId: globalCandidate.id, reviewedContent: 'Shared fact.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-05T00:00:00.000Z'),
    })
    const channelMemory = repositories.createMemoryFromCandidate({
      candidateId: channelCandidate.id, reviewedContent: 'Shared fact.', reviewedScope: 'channel',
      occurredAt: new Date('2026-08-05T00:01:00.000Z'),
    })
    database!.close()
    database = undefined
    restoreOriginalMigration19Schema(databasePath)

    database = createSqliteDatabase(databasePath)

    expect(database.database.prepare(`
      SELECT memory_id, candidate_id FROM memory_sources WHERE message_id = ? ORDER BY memory_id
    `).all(source.id)).toEqual([
      { memory_id: globalMemory.id, candidate_id: globalCandidate.id },
      { memory_id: channelMemory.id, candidate_id: channelCandidate.id },
    ].sort((left, right) => left.memory_id.localeCompare(right.memory_id)))
  })

  it('preserves ac16 migration 19 candidate provenance when one Memory has two candidates for one source', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Shared ac16 source.',
    })
    const firstCandidate = repositories.createMemoryCandidate({
      dreamRunId: repositories.createDreamRun({
        scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null,
        to: { createdAt: source.createdAt, id: source.id },
      }).id,
      proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'Ac16 fact.',
      rationale: 'First.', confidence: 0.9, importance: 0.8, sourceMessageIds: [source.id],
    })
    const memory = repositories.createMemoryFromCandidate({
      candidateId: firstCandidate.id, reviewedContent: 'Ac16 fact.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-05T00:00:00.000Z'),
    })
    const secondCandidate = repositories.createMemoryCandidate({
      dreamRunId: repositories.createDreamRun({
        scope: 'channel', scopeId: channel.id, trigger: 'scheduled', from: null, to: null,
      }).id,
      proposedScope: 'global', channelId: null, kind: 'fact', proposedContent: 'Ac16 fact.',
      rationale: 'Second.', confidence: 0.9, importance: 0.8, sourceMessageIds: [source.id],
    })
    repositories.createMemoryFromCandidate({
      candidateId: secondCandidate.id, reviewedContent: 'Ac16 fact.', reviewedScope: 'global',
      occurredAt: new Date('2026-08-05T00:01:00.000Z'),
    })
    database!.close()
    database = undefined
    restoreAc16Migration19Schema(databasePath)

    database = createSqliteDatabase(databasePath)

    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 20').get())
      .toEqual({ version: 20 })
    expect(database.database.prepare(`
      SELECT candidate_id, message_id FROM memory_sources WHERE memory_id = ? ORDER BY candidate_id
    `).all(memory.id)).toEqual([
      { candidate_id: firstCandidate.id, message_id: source.id },
      { candidate_id: secondCandidate.id, message_id: source.id },
    ].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)))
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
        activeTurnsByChannel: {},
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

  it('keeps active Invocation projection order stable by sequence across repository reconstruction', () => {
    database = createSqliteDatabase(':memory:')
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const channel = createChannel(repositories)
    const firstAgent = repositories.createAgent({
      identity: 'First', mentionName: 'first', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const secondAgent = repositories.createAgent({
      identity: 'Second', mentionName: 'second', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const message = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Stable order.',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id, triggerMessageId: message.id, threadRootMessageId: null,
      mode: 'multi_direct', maxRounds: 3,
    })
    const first = repositories.createAgentInvocation({
      turnId: turn.id, agentId: firstAgent.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:first`, sourceInvocationId: null,
    })
    const second = repositories.createAgentInvocation({
      turnId: turn.id, agentId: secondAgent.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:second`, sourceInvocationId: null,
    })
    const sameQueuedAt = '2026-07-31T08:00:00.000Z'
    database.database.prepare('UPDATE agent_invocations SET id = ?, queued_at = ? WHERE id = ?')
      .run('zzzz-sequence-0', sameQueuedAt, first.id)
    database.database.prepare('UPDATE agent_invocations SET id = ?, queued_at = ? WHERE id = ?')
      .run('aaaa-sequence-1', sameQueuedAt, second.id)

    const expectedAgentOrder = [firstAgent.id, secondAgent.id]
    expect(repositories.listAgentInvocations(turn.id).map((invocation) => invocation.agentId))
      .toEqual(expectedAgentOrder)
    expect(repositories.listActiveConversationActivity(channel.id)[0]!.invocations
      .map((invocation) => invocation.agentId)).toEqual(expectedAgentOrder)

    const rebuilt = new SqliteRepositories(database, new RecordingPublisher())
    expect(rebuilt.listActiveConversationActivity(channel.id)[0]!.invocations
      .map((invocation) => invocation.agentId)).toEqual(expectedAgentOrder)
    expect(new ChannelTurnCoordinator({ repositories: rebuilt }).getActiveStatesByChannel()[channel.id]
      .map((activity) => activity.agentId)).toEqual(expectedAgentOrder)
    expect(rebuilt.listActiveConversationActivity(channel.id)[0]!.invocations[0])
      .not.toHaveProperty('sequence')
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
    expect(database.database.prepare('SELECT version FROM schema_migrations WHERE version = 18').get())
      .toEqual({ version: 18 })
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

  it('claims recoverable Turns once across SQLite connections and atomically requeues running Invocations', async () => {
    const { repositories, databasePath } = await createRepositories()
    const channel = createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'Recovery Agent', mentionName: 'recovery-agent', runtime: 'opencode', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: {},
    })
    const createTurn = (
      status: 'screening' | 'completed' | 'partial' | 'cancelled' | 'failed',
      priority: 'human_direct' | 'automatic_handoff',
    ) => {
      const message = repositories.createMessage({
        channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: `${status}-${priority}`,
      })
      const turn = repositories.createConversationTurn({
        channelId: channel.id, triggerMessageId: message.id, threadRootMessageId: null,
        mode: 'direct', maxRounds: 3,
      })
      repositories.updateConversationTurn(turn.id, status === 'screening'
        ? { status }
        : { status, completedAt: '2026-08-01T00:00:00.000Z' })
      const invocation = repositories.createAgentInvocation({
        turnId: turn.id, agentId: agent.id, kind: 'response', priority, round: 1,
        idempotencyKey: `${turn.id}:response`, sourceInvocationId: null,
        status: 'running', startedAt: '2026-08-01T00:00:00.000Z',
      })
      return { turn, invocation }
    }
    const active = createTurn('screening', 'human_direct')
    const lowerPriority = createTurn('screening', 'automatic_handoff')
    repositories.updateAgentInvocation(lowerPriority.invocation.id, { status: 'queued', startedAt: null })
    const completed = createTurn('completed', 'automatic_handoff')
    const partial = createTurn('partial', 'human_direct')
    const cancelled = createTurn('cancelled', 'human_direct')
    const failed = createTurn('failed', 'human_direct')
    const liveMessage = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'live claimed turn',
    })
    const live = repositories.createClaimedConversationTurn({
      channelId: channel.id, triggerMessageId: liveMessage.id, threadRootMessageId: null,
      mode: 'direct', maxRounds: 3,
    }, 'live-owner', new Date('2026-08-02T00:00:00.000Z'))
    const secondDatabase = createSqliteDatabase(databasePath)
    const competing = new SqliteRepositories(secondDatabase, new RecordingPublisher())

    try {
      const claimed = repositories.claimRecoverableConversationTurns(
        'owner-a',
        new Date('2026-08-02T00:00:00.000Z'),
        new Date('2026-08-01T23:59:00.000Z'),
      )
      const duplicateClaim = competing.claimRecoverableConversationTurns(
        'owner-b',
        new Date('2026-08-02T00:00:01.000Z'),
        new Date('2026-08-01T23:59:01.000Z'),
      )

      expect(claimed.map((projection) => projection.turn.id)).toEqual([active.turn.id, lowerPriority.turn.id])
      expect(claimed[0]?.invocations).toEqual([
        expect.objectContaining({ id: active.invocation.id, status: 'queued', startedAt: null }),
      ])
      expect(claimed[1]?.invocations).toEqual([
        expect.objectContaining({ id: lowerPriority.invocation.id, status: 'queued', startedAt: null }),
      ])
      expect(duplicateClaim).toEqual([])
      expect(claimed.map((projection) => projection.turn.id)).not.toContain(live.id)
      expect(repositories.getConversationTurn(completed.turn.id)?.status).toBe('completed')
      expect(repositories.listAgentInvocations(completed.turn.id)[0]).toMatchObject({ status: 'running' })
      expect(repositories.getConversationTurn(partial.turn.id)?.status).toBe('partial')
      expect(repositories.listAgentInvocations(partial.turn.id)[0]).toMatchObject({ status: 'running' })
      expect(repositories.getConversationTurn(cancelled.turn.id)?.status).toBe('cancelled')
      expect(repositories.getConversationTurn(failed.turn.id)?.status).toBe('failed')
      expect(repositories.listAgentInvocations(failed.turn.id)[0]).toMatchObject({ status: 'running' })
    } finally {
      secondDatabase.close()
    }
  })

  it('cancels a claimed Turn with owner CAS and atomically converges its active persisted chain', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const source = repositories.createAgent({
      identity: 'Cancel Source', mentionName: 'cancel-source', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const target = repositories.createAgent({
      identity: 'Cancel Target', mentionName: 'cancel-target', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const trigger = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: '@Cancel Source stop.',
    })
    const turn = repositories.createClaimedConversationTurn({
      channelId: channel.id, triggerMessageId: trigger.id, threadRootMessageId: null,
      mode: 'direct', maxRounds: 3,
    }, 'owner-a', new Date('2026-08-02T00:00:00.000Z'))
    const participant = repositories.createTurnParticipant({
      turnId: turn.id, agentId: source.id, source: 'direct', rank: 1, matcherScore: null,
      decision: 'speak', status: 'selected',
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id, agentId: source.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:response`, sourceInvocationId: null,
      status: 'running', startedAt: '2026-08-02T00:00:01.000Z',
    })
    const handoff = repositories.createConversationHandoff({
      turnId: turn.id, sourceInvocationId: invocation.id, fromAgentId: source.id,
      requestedTargetAgentId: target.id, toAgentId: target.id, question: 'Continue?', round: 2,
      status: 'accepted',
    })

    const staleOwner = repositories.cancelConversationTurn({
      turnId: turn.id,
      expectedRecoveryOwnerId: 'owner-b',
      occurredAt: new Date('2026-08-02T00:00:02.000Z'),
      reason: 'turn_cancelled',
    })

    expect(staleOwner).toMatchObject({ applied: false, turn: { status: 'screening' } })
    expect(repositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'running' })
    expect(repositories.listTurnParticipants(turn.id)[0]).toMatchObject({ status: 'selected' })
    expect(repositories.listConversationHandoffs(turn.id)[0]).toMatchObject({ status: 'accepted' })

    const cancelled = repositories.cancelConversationTurn({
      turnId: turn.id,
      expectedRecoveryOwnerId: 'owner-a',
      occurredAt: new Date('2026-08-02T00:00:03.000Z'),
      reason: 'turn_cancelled',
    })

    expect(cancelled).toMatchObject({
      applied: true,
      turn: { status: 'cancelled', completedAt: '2026-08-02T00:00:03.000Z' },
      invocationIds: [invocation.id],
      participantIds: [participant.id],
      handoffIds: [handoff.id],
    })
    expect(repositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'cancelled' })
    expect(repositories.listTurnParticipants(turn.id)[0]).toMatchObject({ status: 'cancelled', reason: 'turn_cancelled' })
    expect(repositories.listConversationHandoffs(turn.id)[0]).toMatchObject({ status: 'failed', reason: 'turn_cancelled' })
    expect(repositories.cancelConversationTurn({
      turnId: turn.id,
      expectedRecoveryOwnerId: 'owner-a',
      occurredAt: new Date('2026-08-02T00:00:04.000Z'),
      reason: 'turn_cancelled',
    })).toMatchObject({ applied: false, turn: { status: 'cancelled' } })
  })

  it('settles a public Invocation idempotently with its message, result, and Participant in one transaction', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'Public Agent', mentionName: 'public-agent', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const trigger = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: '@Public Agent answer.',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id, triggerMessageId: trigger.id, threadRootMessageId: null,
      mode: 'direct', maxRounds: 3,
    })
    repositories.createTurnParticipant({
      turnId: turn.id, agentId: agent.id, source: 'direct', rank: 1, matcherScore: null,
      decision: 'speak', status: 'selected',
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id, agentId: agent.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:response`, sourceInvocationId: null,
      status: 'running', startedAt: '2026-08-02T00:00:00.000Z',
    })
    repositories.claimRecoverableConversationTurns(
      'owner-a', new Date('2026-08-02T00:00:01.000Z'), new Date('2026-08-01T23:59:00.000Z'),
    )
    repositories.updateAgentInvocation(invocation.id, { status: 'running' })
    const resultJson = JSON.stringify({ reply: 'Persisted once.', handoffTo: [] })

    const first = repositories.settleConversationInvocation({
      invocationId: invocation.id,
      recoveryOwnerId: 'owner-a',
      resultJson,
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: agent.identity, body: 'Persisted once.' },
      occurredAt: new Date('2026-08-02T00:00:02.000Z'),
    })
    const repeated = repositories.settleConversationInvocation({
      invocationId: invocation.id,
      recoveryOwnerId: 'owner-a',
      resultJson,
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: agent.identity, body: 'Persisted once.' },
      occurredAt: new Date('2026-08-02T00:00:03.000Z'),
    })
    repositories.releaseConversationTurnClaim(turn.id, 'owner-a')
    const staleOwner = repositories.settleConversationInvocation({
      invocationId: invocation.id,
      recoveryOwnerId: 'owner-a',
      resultJson,
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: agent.identity, body: 'Persisted once.' },
      occurredAt: new Date('2026-08-02T00:00:04.000Z'),
    })

    expect(first).toMatchObject({ applied: true, message: { body: 'Persisted once.' } })
    expect(repeated).toMatchObject({ applied: true, message: { id: first.message?.id } })
    expect(staleOwner).toMatchObject({ applied: false })
    expect(repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ id: invocation.id, status: 'settled', resultJson }),
    ])
    expect(repositories.listTurnParticipants(turn.id)).toEqual([
      expect.objectContaining({ agentId: agent.id, status: 'spoken' }),
    ])
    expect(repositories.listMessagesForConversation(channel.id, null)
      .filter((message) => message.senderType === 'agent')).toEqual([
      expect.objectContaining({ id: first.message?.id, body: 'Persisted once.' }),
    ])
  })

  it('rolls back public message creation when Participant settlement fails', async () => {
    const { repositories } = await createRepositories()
    const channel = createChannel(repositories)
    const agent = repositories.createAgent({
      identity: 'Rollback Agent', mentionName: 'rollback-agent', runtime: 'pi', capabilityTags: [],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: {},
    })
    const trigger = repositories.createMessage({
      channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: 'Rollback.',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id, triggerMessageId: trigger.id, threadRootMessageId: null,
      mode: 'direct', maxRounds: 3,
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id, agentId: agent.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:response`, sourceInvocationId: null, status: 'running',
    })

    expect(() => repositories.settleConversationInvocation({
      invocationId: invocation.id,
      recoveryOwnerId: null,
      resultJson: JSON.stringify({ reply: 'Must roll back.', handoffTo: [] }),
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: agent.identity, body: 'Must roll back.' },
      occurredAt: new Date('2026-08-02T00:00:00.000Z'),
    })).toThrow(/participant/i)
    expect(repositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'running', resultJson: null })
    expect(repositories.listMessagesForConversation(channel.id, null)
      .filter((message) => message.senderType === 'agent')).toEqual([])
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
      INSERT INTO conversation_turns_v16 (
        id, channel_id, trigger_message_id, thread_root_message_id, mode, status,
        current_round, max_rounds, created_at, updated_at, completed_at
      ) SELECT
        id, channel_id, trigger_message_id, thread_root_message_id, mode, status,
        current_round, max_rounds, created_at, updated_at, completed_at
      FROM conversation_turns;
      DROP TABLE conversation_turns;
      ALTER TABLE conversation_turns_v16 RENAME TO conversation_turns;
      CREATE INDEX conversation_turns_status_created_at_idx ON conversation_turns(status, created_at);
      DROP TABLE conversation_invocation_messages;
      ALTER TABLE agent_invocations DROP COLUMN result_json;
      DELETE FROM schema_migrations WHERE version IN (17, 18);
      COMMIT;
    `)
    legacy.close()
  }

  function downgradeDreamMemoryToVersion18(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_insert;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_update;
      DROP TRIGGER thread_summaries_channel_match;
      DROP TRIGGER IF EXISTS memory_sources_candidate_match;
      DROP TRIGGER IF EXISTS memory_sources_channel_match;
      DROP TRIGGER memory_candidate_sources_channel_match;
      DROP TRIGGER memory_candidates_channel_match;
      DROP TRIGGER dream_run_sources_channel_match;
      DROP TRIGGER dream_runs_boundary_channel_match;
      DROP TABLE memory_sources;
      DROP TABLE memories;
      DROP TABLE memory_candidate_sources;
      DROP TABLE memory_candidates;
      DROP TABLE dream_run_sources;
      DROP TABLE dream_runs;
      DROP TABLE thread_summaries;
      DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22);
      COMMIT;
    `)
    legacy.close()
  }

  function restoreOriginalMigration19Schema(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_insert;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_update;
      DROP TRIGGER IF EXISTS memory_sources_candidate_match;
      DROP TRIGGER IF EXISTS memory_sources_channel_match;
      ALTER TABLE memory_sources RENAME TO memory_sources_current;
      CREATE TABLE memory_sources (
        memory_id TEXT NOT NULL REFERENCES memories(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        turn_id TEXT REFERENCES conversation_turns(id),
        PRIMARY KEY (memory_id, message_id)
      );
      INSERT INTO memory_sources (memory_id, message_id, turn_id)
      SELECT memory_id, message_id, turn_id FROM memory_sources_current;
      DROP TABLE memory_sources_current;
      CREATE TRIGGER memory_sources_channel_match
      BEFORE INSERT ON memory_sources
      WHEN (SELECT channel_id FROM messages WHERE id = NEW.message_id)
        != (SELECT dream_runs.scope_id
            FROM memories
            JOIN memory_candidates ON memory_candidates.id = memories.source_candidate_id
            JOIN dream_runs ON dream_runs.id = memory_candidates.dream_run_id
            WHERE memories.id = NEW.memory_id)
      BEGIN
        SELECT RAISE(ABORT, 'Memory source message must belong to the Dream channel.');
      END;
      DROP INDEX dream_runs_channel_watermark_unique_idx;
      CREATE UNIQUE INDEX dream_runs_channel_watermark_unique_idx
        ON dream_runs(scope_id, to_message_created_at, to_message_id);
      DELETE FROM schema_migrations WHERE version IN (20, 21, 22);
      COMMIT;
    `)
    legacy.close()
  }

  function restoreAc16Migration19Schema(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      BEGIN;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_insert;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_update;
      DELETE FROM schema_migrations WHERE version IN (20, 21, 22);
      COMMIT;
    `)
    legacy.close()
  }

  function downgradeThreadSummariesToVersion20(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_insert;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_update;
      ALTER TABLE thread_summaries DROP COLUMN through_message_id;
      ALTER TABLE thread_summaries DROP COLUMN through_message_created_at;
      DELETE FROM schema_migrations WHERE version IN (21, 22);
      COMMIT;
    `)
    legacy.close()
  }

  function downgradeThreadSummaryConstraintsToVersion21(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      BEGIN;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_insert;
      DROP TRIGGER IF EXISTS thread_summaries_watermark_pair_update;
      DELETE FROM schema_migrations WHERE version = 22;
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
