import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import { ChannelMessageService } from './channel-message-service'
import { ContextAssembler } from './context-assembler'

describe('ContextAssembler', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
    database = undefined
  })

  it('reads the reset-aware Timeline and drops oldest complete messages to fit the character budget', async () => {
    const fixture = await createFixture()
    const beforeReset = fixture.messages.postHuman(fixture.channelId, 'before reset')
    const oldest = fixture.messages.postHuman(fixture.channelId, 'oldest retained candidate')
    const middle = fixture.messages.postHuman(fixture.channelId, 'middle retained')
    const newest = fixture.messages.postAgent(fixture.channelId, null, fixture.agentId, 'Build', 'newest retained')
    const current = fixture.messages.postHuman(fixture.channelId, 'current message')
    fixture.at(beforeReset.id, '2026-07-31T08:00:00.000Z')
    fixture.resetAt('2026-07-31T08:00:30.000Z')
    fixture.at(oldest.id, '2026-07-31T08:01:00.000Z')
    fixture.at(middle.id, '2026-07-31T08:02:00.000Z')
    fixture.at(newest.id, '2026-07-31T08:03:00.000Z')
    fixture.at(current.id, '2026-07-31T08:04:00.000Z')

    const rendered = '近期公开消息：\nYou: middle retained\nBuild: newest retained'
    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: null,
      currentMessageId: current.id,
      tokenBudget: rendered.length,
    })

    expect(context.recentMessages.map((message) => message.id)).toEqual([middle.id, newest.id])
    expect(fixture.assembler.render(context)).toBe(rendered)
    expect(fixture.assembler.render(context).length).toBeLessThanOrEqual(rendered.length)
  })

  it('uses only the root and replies from the selected Thread', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'deployment root')
    fixture.messages.postHuman(fixture.channelId, 'unrelated Timeline message')
    const reply = fixture.messages.postAgent(fixture.channelId, null, fixture.agentId, 'Build', 'thread reply', root.id)
    const otherRoot = fixture.messages.postHuman(fixture.channelId, 'other root')
    fixture.messages.postHuman(fixture.channelId, 'other thread reply', null, otherRoot.id)
    const current = fixture.messages.postHuman(fixture.channelId, 'current thread message', null, root.id)

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    })

    expect(context.recentMessages.map((message) => message.id)).toEqual([root.id, reply.id])
    expect(fixture.assembler.render(context)).not.toContain('unrelated Timeline message')
    expect(fixture.assembler.render(context)).not.toContain('other thread reply')
  })

  it('keeps only Thread messages after the saved Summary watermark', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const summarized = fixture.messages.postAgent(
      fixture.channelId, null, fixture.agentId, 'Build', 'Already summarized reply', root.id,
    )
    const unsummarized = fixture.messages.postHuman(fixture.channelId, 'New reply after the watermark', null, root.id)
    const current = fixture.messages.postHuman(fixture.channelId, 'Current thread message', null, root.id)
    fixture.at(root.id, '2026-08-01T08:00:00.000Z')
    fixture.at(summarized.id, '2026-08-01T08:01:00.000Z')
    fixture.at(unsummarized.id, '2026-08-01T08:02:00.000Z')
    fixture.at(current.id, '2026-08-01T08:03:00.000Z')
    fixture.repositories.upsertThreadSummary({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      content: 'Summary through the first reply.',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z',
      throughMessageId: summarized.id,
    })

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    })

    expect(context.threadSummary).toBe('Summary through the first reply.')
    expect(context.recentMessages.map((message) => message.id)).toEqual([unsummarized.id])
  })

  it('uses stable conversation order after a visible same-millisecond Summary watermark', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    fixture.at(root.id, '2026-08-01T08:00:00.000Z')
    fixture.insertThreadMessage(root.id, 'z-context-watermark', 'Already summarized', '2026-08-01T08:01:00.000Z')
    fixture.insertThreadMessage(root.id, 'a-context-after', 'New despite inverse lexical ID', '2026-08-01T08:01:00.000Z')
    const current = fixture.messages.postHuman(fixture.channelId, 'Current thread message', null, root.id)
    fixture.at(current.id, '2026-08-01T08:02:00.000Z')
    fixture.repositories.upsertThreadSummary({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      content: 'Summary through the first reply.',
      throughMessageCreatedAt: '2026-08-01T08:01:00.000Z',
      throughMessageId: 'z-context-watermark',
    })

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    })

    expect(context.recentMessages.map((message) => message.id)).toEqual(['a-context-after'])
  })

  it('does not skip an oversized newer message to retain older messages', async () => {
    const fixture = await createFixture()
    fixture.messages.postHuman(fixture.channelId, 'small old message')
    fixture.messages.postHuman(fixture.channelId, 'x'.repeat(100))
    const current = fixture.messages.postHuman(fixture.channelId, 'current message')

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: null,
      currentMessageId: current.id,
      tokenBudget: 50,
    })

    expect(context.recentMessages).toEqual([])
  })

  it('excludes deleted messages and non-message Runtime and Turn records', async () => {
    const fixture = await createFixture()
    const visible = fixture.messages.postHuman(fixture.channelId, 'visible public fact')
    const deleted = fixture.messages.postHuman(fixture.channelId, 'deleted secret')
    fixture.repositories.deleteMessage(deleted.id)
    const current = fixture.messages.postHuman(fixture.channelId, 'current message')

    const agent = fixture.repositories.createAgent({
      identity: 'Build', mentionName: 'build', runtime: 'opencode', capabilityTags: [],
      responsibilities: ['构建'], maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: {},
    })
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channelId,
      triggerMessageId: current.id,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })
    fixture.repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: agent.id,
      kind: 'participation',
      priority: 'participation',
      round: 0,
      idempotencyKey: 'internal-decision-secret',
      sourceInvocationId: null,
    })

    const rendered = fixture.assembler.render(fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: null,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    }))

    expect(rendered).toContain(visible.body)
    expect(rendered).not.toContain(deleted.body)
    expect(rendered).not.toContain('internal-decision-secret')
  })

  it('renders active confirmed Global and Channel Memory before a Thread Summary and recent public messages', async () => {
    const fixture = await createFixture()
    const globalMemory = acceptMemory(fixture, 'global', 'Global: use TypeScript', '2026-08-01T08:00:00.000Z')
    const channelMemory = acceptMemory(fixture, 'channel', 'Channel: deploy with canary', '2026-08-01T09:00:00.000Z')
    const archivedMemory = acceptMemory(fixture, 'channel', 'Archived: do not render', '2026-08-01T10:00:00.000Z')
    fixture.repositories.archiveMemory(archivedMemory.id, new Date('2026-08-01T11:00:00.000Z'))
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const reply = fixture.messages.postAgent(fixture.channelId, null, fixture.agentId, 'Build', 'Thread reply', root.id)
    const current = fixture.messages.postHuman(fixture.channelId, 'Current thread message', null, root.id)
    fixture.database.database.prepare(`
      INSERT INTO thread_summaries (channel_id, thread_root_message_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(fixture.channelId, root.id, 'Summary: accepted design choices', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z')

    const rendered = fixture.assembler.render(fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    }))

    expect(rendered).toContain(globalMemory.content)
    expect(rendered).toContain(channelMemory.content)
    expect(rendered).toContain('Summary: accepted design choices')
    expect(rendered).toContain(reply.body)
    expect(rendered).not.toContain(archivedMemory.content)
    expect(rendered.indexOf(globalMemory.content)).toBeLessThan(rendered.indexOf(channelMemory.content))
    expect(rendered.indexOf(channelMemory.content)).toBeLessThan(rendered.indexOf('Summary: accepted design choices'))
    expect(rendered.indexOf('Summary: accepted design choices')).toBeLessThan(rendered.indexOf(reply.body))
  })

  it('does not inject a Thread Summary into Timeline context', async () => {
    const fixture = await createFixture()
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const current = fixture.messages.postHuman(fixture.channelId, 'Timeline message')
    fixture.database.database.prepare(`
      INSERT INTO thread_summaries (channel_id, thread_root_message_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(fixture.channelId, root.id, 'Thread-only summary', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z')

    const rendered = fixture.assembler.render(fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: null,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    }))

    expect(rendered).not.toContain('Thread-only summary')
  })

  it('excludes unconfirmed Candidates and Channel Memory from another channel', async () => {
    const fixture = await createFixture()
    const otherChannel = fixture.repositories.createChannel({ name: 'other-channel' })
    const accepted = acceptMemory(fixture, 'channel', 'Accepted current-channel fact', '2026-08-01T08:00:00.000Z')
    const pending = createCandidate(fixture, 'channel', 'Pending candidate must stay out')
    const ignored = createCandidate(fixture, 'channel', 'Ignored candidate must stay out')
    fixture.repositories.reviewMemoryCandidate({
      candidateId: ignored.id, status: 'ignored', occurredAt: new Date('2026-08-01T08:01:00.000Z'),
    })
    const superseded = createCandidate(fixture, 'channel', 'Superseded candidate must stay out')
    fixture.repositories.reviewMemoryCandidate({
      candidateId: superseded.id, status: 'superseded', occurredAt: new Date('2026-08-01T08:02:00.000Z'),
    })
    const other = acceptMemory(
      fixture, 'channel', 'Other-channel fact must stay out', '2026-08-01T08:03:00.000Z',
      { channelId: otherChannel.id },
    )
    const current = fixture.messages.postHuman(fixture.channelId, 'Current message')

    const rendered = fixture.assembler.render(fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: null,
      currentMessageId: current.id,
      tokenBudget: 10_000,
    }))

    expect(rendered).toContain(accepted.content)
    expect(rendered).not.toContain(pending.proposedContent)
    expect(rendered).not.toContain(ignored.proposedContent)
    expect(rendered).not.toContain(superseded.proposedContent)
    expect(rendered).not.toContain(other.content)
  })

  it('drops recent messages before truncating a Thread Summary as the budget shrinks', async () => {
    const fixture = await createFixture()
    const memory = acceptMemory(fixture, 'global', 'memory', '2026-08-01T08:00:00.000Z')
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const recent = fixture.messages.postHuman(fixture.channelId, 'R'.repeat(100), null, root.id)
    const current = fixture.messages.postHuman(fixture.channelId, 'Current thread message', null, root.id)
    fixture.at(root.id, '2026-08-01T09:00:00.000Z')
    fixture.at(recent.id, '2026-08-01T09:01:00.000Z')
    fixture.at(current.id, '2026-08-01T09:02:00.000Z')
    fixture.repositories.upsertThreadSummary({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      content: 'S'.repeat(12),
      throughMessageCreatedAt: '2026-08-01T09:00:00.000Z',
      throughMessageId: root.id,
    })

    const withRecentBudget = fixture.assembler.render({
      globalMemory: [memory], channelMemory: [], threadSummary: 'S'.repeat(12), recentMessages: [recent],
    }).length
    const withoutRecentBudget = fixture.assembler.render({
      globalMemory: [memory], channelMemory: [], threadSummary: 'S'.repeat(12), recentMessages: [],
    }).length
    const truncatedSummaryBudget = withoutRecentBudget - 1
    const withRecent = fixture.assembler.assemble({
      channelId: fixture.channelId, threadRootMessageId: root.id, currentMessageId: current.id,
      tokenBudget: withRecentBudget,
    })
    const withoutRecent = fixture.assembler.assemble({
      channelId: fixture.channelId, threadRootMessageId: root.id, currentMessageId: current.id,
      tokenBudget: withoutRecentBudget,
    })
    const truncatedSummary = fixture.assembler.assemble({
      channelId: fixture.channelId, threadRootMessageId: root.id, currentMessageId: current.id,
      tokenBudget: truncatedSummaryBudget,
    })

    expect(withRecent).toMatchObject({
      globalMemory: [expect.objectContaining({ id: memory.id })],
      threadSummary: 'S'.repeat(12),
      recentMessages: [expect.objectContaining({ id: recent.id })],
    })
    expect(withoutRecent.threadSummary).toBe('S'.repeat(12))
    expect(withoutRecent.recentMessages).toEqual([])
    expect(truncatedSummary.threadSummary).toBe(`${'S'.repeat(8)}...`)
    expect(truncatedSummary.recentMessages).toEqual([])
    expect(fixture.assembler.render(withRecent).length).toBeLessThanOrEqual(withRecentBudget)
    expect(fixture.assembler.render(withoutRecent).length).toBeLessThanOrEqual(withoutRecentBudget)
    expect(fixture.assembler.render(truncatedSummary).length).toBeLessThanOrEqual(truncatedSummaryBudget)
  })

  it('retains the higher-quality Memory when update times and content costs tie', async () => {
    const fixture = await createFixture()
    const lower = acceptMemory(
      fixture, 'global', 'L'.repeat(100), '2026-08-01T08:00:00.000Z', { confidence: 0.2, importance: 0.2 },
    )
    const higher = acceptMemory(
      fixture, 'global', 'H'.repeat(100), '2026-08-01T08:00:00.000Z', { confidence: 0.9, importance: 0.9 },
    )
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const current = fixture.messages.postHuman(fixture.channelId, 'Current message', null, root.id)
    const tokenBudget = fixture.assembler.render({
      globalMemory: [higher], channelMemory: [], threadSummary: null, recentMessages: [root],
    }).length

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      currentMessageId: current.id,
      tokenBudget,
    })

    expect(context.globalMemory.map((memory) => memory.id)).toEqual([higher.id])
    expect(context.globalMemory.map((memory) => memory.id)).not.toContain(lower.id)
    expect(fixture.assembler.render(context).length).toBeLessThanOrEqual(tokenBudget)
  })

  it('selects Memory across Global and Channel scope before partitioning sections for render', async () => {
    const fixture = await createFixture()
    const globalMemory = acceptMemory(
      fixture, 'global', 'G'.repeat(200), '2026-08-01T08:00:00.000Z', { confidence: 0.2, importance: 0.2 },
    )
    const channelMemory = acceptMemory(
      fixture, 'channel', 'C'.repeat(200), '2026-08-01T09:00:00.000Z', { confidence: 0.9, importance: 0.9 },
    )
    const root = fixture.messages.postHuman(fixture.channelId, 'Thread root')
    const current = fixture.messages.postHuman(fixture.channelId, 'Current message', null, root.id)
    const tokenBudget = fixture.assembler.render({
      globalMemory: [], channelMemory: [channelMemory], threadSummary: null, recentMessages: [root],
    }).length

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: root.id,
      currentMessageId: current.id,
      tokenBudget,
    })

    expect(context.globalMemory.map((memory) => memory.id)).not.toContain(globalMemory.id)
    expect(context.channelMemory.map((memory) => memory.id)).toEqual([channelMemory.id])
    expect(fixture.assembler.render(context).length).toBeLessThanOrEqual(tokenBudget)
  })

  async function createFixture() {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-context-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({
      workspaceId: workspace.id,
      name: 'demo',
      path: '/workspace/demo',
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ name: 'general' })
    const agent = repositories.createAgent({
      identity: 'Build', mentionName: 'build-context', runtime: 'opencode', capabilityTags: [],
      responsibilities: ['构建'], maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: {},
    })
    const messages = new ChannelMessageService(repositories)
    const assembler = new ContextAssembler(repositories)
    return {
      repositories,
      database,
      channelId: channel.id,
      agentId: agent.id,
      messages,
      assembler,
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
      resetAt(occurredAt: string) {
        database!.database.prepare('UPDATE channels SET context_reset_at = ? WHERE id = ?').run(occurredAt, channel.id)
      },
    }
  }

  function acceptMemory(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    scope: 'global' | 'channel',
    content: string,
    occurredAt: string,
    options: { channelId?: string; confidence?: number; importance?: number } = {},
  ) {
    const candidate = createCandidate(fixture, scope, content, options)
    return fixture.repositories.createMemoryFromCandidate({
      candidateId: candidate.id, reviewedContent: content, reviewedScope: scope, occurredAt: new Date(occurredAt),
    })
  }

  function createCandidate(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    scope: 'global' | 'channel',
    content: string,
    options: { channelId?: string; confidence?: number; importance?: number } = {},
  ) {
    const channelId = options.channelId ?? fixture.channelId
    const source = fixture.messages.postHuman(channelId, 'Source message for memory review')
    const run = fixture.repositories.createDreamRun({
      scope: 'channel', scopeId: channelId, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    return fixture.repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: scope, channelId: scope === 'channel' ? channelId : null,
      kind: 'fact', proposedContent: content, rationale: 'Confirmed by review.',
      confidence: options.confidence ?? 0.9, importance: options.importance ?? 0.8,
      sourceMessageIds: [source.id],
    })
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
