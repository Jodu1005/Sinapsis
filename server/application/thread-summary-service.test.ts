import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import { ChannelMessageService } from './channel-message-service'
import { ThreadSummaryService } from './thread-summary-service'

describe('ThreadSummaryService', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
    database = undefined
  })

  it('summarizes only new undeleted Thread messages and becomes a no-op at the saved watermark', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const first = fixture.messages.postAgent(fixture.channelId, null, fixture.agentId, 'Build', 'First public reply', root.id)
    const deleted = fixture.messages.postHuman(fixture.channelId, 'Deleted reply', null, root.id)
    fixture.at(root.id, '2026-08-01T08:00:00.000Z')
    fixture.at(first.id, '2026-08-01T08:01:00.000Z')
    fixture.at(deleted.id, '2026-08-01T08:02:00.000Z')
    fixture.repositories.deleteMessage(deleted.id)
    const summarize = vi.fn(async ({ previousSummary, messages }: { previousSummary: string | null; messages: Array<{ body: string }> }) =>
      `${previousSummary ?? 'initial'} | ${messages.map((message) => message.body).join(' / ')}`)
    const service = new ThreadSummaryService(fixture.repositories, { summarize })

    const firstSummary = await service.refresh(fixture.channelId, root.id)
    const second = fixture.messages.postHuman(fixture.channelId, 'Second public reply', null, root.id)
    fixture.at(second.id, '2026-08-01T08:03:00.000Z')
    const secondSummary = await service.refresh(fixture.channelId, root.id)
    const noOpSummary = await service.refresh(fixture.channelId, root.id)

    expect(firstSummary).toMatchObject({
      content: 'initial | Thread root / First public reply',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z',
      throughMessageId: first.id,
    })
    expect(secondSummary).toMatchObject({
      content: 'initial | Thread root / First public reply | Second public reply',
      throughMessageCreatedAt: '2026-08-01T08:03:00.000Z',
      throughMessageId: second.id,
    })
    expect(noOpSummary).toEqual(secondSummary)
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(summarize.mock.calls[1]![0]).toMatchObject({
      previousSummary: firstSummary?.content,
      messages: [{ body: 'Second public reply' }],
    })
  })

  it('keeps the previous Summary when an update fails', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const first = fixture.messages.postHuman(fixture.channelId, 'First public reply', null, root.id)
    fixture.at(root.id, '2026-08-01T08:00:00.000Z')
    fixture.at(first.id, '2026-08-01T08:01:00.000Z')
    fixture.repositories.upsertThreadSummary({
      channelId: fixture.channelId, threadRootMessageId: root.id, content: 'Previously saved summary.',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z', throughMessageId: first.id,
    })
    const next = fixture.messages.postHuman(fixture.channelId, 'New public reply', null, root.id)
    fixture.at(next.id, '2026-08-01T08:02:00.000Z')
    const service = new ThreadSummaryService(fixture.repositories, {
      summarize: async () => { throw new Error('summary model unavailable') },
    })

    await expect(service.refresh(fixture.channelId, root.id)).resolves.toMatchObject({ content: 'Previously saved summary.' })
    expect(fixture.repositories.getThreadSummary(fixture.channelId, root.id)).toMatchObject({ content: 'Previously saved summary.' })
  })

  it('uses stable conversation order after a visible same-millisecond watermark', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    fixture.at(root.id, '2026-08-01T08:00:00.000Z')
    fixture.insertThreadMessage(root.id, 'z-watermark', 'Already summarized', '2026-08-01T08:01:00.000Z')
    fixture.insertThreadMessage(root.id, 'a-after', 'New despite inverse lexical ID', '2026-08-01T08:01:00.000Z')
    fixture.repositories.upsertThreadSummary({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      content: 'Previous summary.',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z',
      throughMessageId: 'z-watermark',
    })
    const summarize = vi.fn(async () => 'Updated summary.')
    const service = new ThreadSummaryService(fixture.repositories, { summarize })

    const refreshed = await service.refresh(fixture.channelId, root.id)

    expect(summarize).toHaveBeenCalledWith({
      previousSummary: 'Previous summary.',
      messages: [expect.objectContaining({ id: 'a-after', body: 'New despite inverse lexical ID' })],
    })
    expect(refreshed).toMatchObject({
      content: 'Updated summary.',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z',
      throughMessageId: 'a-after',
    })
  })

  it('falls back to the timestamp and ID boundary when the watermark message was deleted', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    fixture.at(root.id, '2026-08-01T08:00:00.000Z')
    fixture.insertThreadMessage(root.id, 'm-watermark', 'Deleted watermark', '2026-08-01T08:01:00.000Z')
    fixture.repositories.upsertThreadSummary({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      content: 'Previous summary.',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z',
      throughMessageId: 'm-watermark',
    })
    fixture.repositories.deleteMessage('m-watermark')
    fixture.insertThreadMessage(root.id, 'a-before', 'Before fallback boundary', '2026-08-01T08:01:00.000Z')
    fixture.insertThreadMessage(root.id, 'z-after', 'After fallback boundary', '2026-08-01T08:01:00.000Z')
    const summarize = vi.fn(async () => 'Updated summary.')
    const service = new ThreadSummaryService(fixture.repositories, { summarize })

    const refreshed = await service.refresh(fixture.channelId, root.id)

    expect(summarize).toHaveBeenCalledWith({
      previousSummary: 'Previous summary.',
      messages: [expect.objectContaining({ id: 'z-after', body: 'After fallback boundary' })],
    })
    expect(refreshed).toMatchObject({ throughMessageId: 'z-after' })
  })

  async function createFixture() {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-thread-summary-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'demo', path: '/workspace/demo', currentBranch: 'main', defaultBranch: 'main', isClean: true })
    const channel = repositories.createChannel({ name: 'general' })
    const agent = repositories.createAgent({
      identity: 'Build', mentionName: 'build-summary', runtime: 'opencode', capabilityTags: [], responsibilities: ['Build'],
      maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: {},
    })
    return {
      repositories,
      channelId: channel.id,
      agentId: agent.id,
      messages: new ChannelMessageService(repositories),
      at(messageId: string, createdAt: string) {
        database!.database.prepare('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?')
          .run(createdAt, createdAt, messageId)
      },
      insertThreadMessage(threadRootMessageId: string, id: string, body: string, createdAt: string) {
        database!.database.prepare(`
          INSERT INTO messages (
            id, channel_id, thread_root_id, task_id, sender_type, sender_id,
            author_name, body, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, channel.id, threadRootMessageId, null, 'human', null,
          'You', body, createdAt, createdAt, null,
        )
      },
    }
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
