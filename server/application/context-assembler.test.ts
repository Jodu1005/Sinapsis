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

    const context = fixture.assembler.assemble({
      channelId: fixture.channelId,
      threadRootMessageId: null,
      currentMessageId: current.id,
      tokenBudget: 'You: middle retained\nBuild: newest retained'.length,
    })

    expect(context.recentMessages.map((message) => message.id)).toEqual([middle.id, newest.id])
    expect(fixture.assembler.render(context)).toBe('近期公开消息：\nYou: middle retained\nBuild: newest retained')
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
      channelId: channel.id,
      agentId: agent.id,
      messages,
      assembler,
      at(messageId: string, createdAt: string) {
        database!.database.prepare('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?')
          .run(createdAt, createdAt, messageId)
      },
      resetAt(occurredAt: string) {
        database!.database.prepare('UPDATE channels SET context_reset_at = ? WHERE id = ?').run(occurredAt, channel.id)
      },
    }
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
