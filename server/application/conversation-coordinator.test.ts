import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeRuntimeAdapter } from '../adapters/runtime/fake-runtime-adapter'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { Agent } from '../domain/agent'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import { ChannelMessageService } from './channel-message-service'
import { ConversationCoordinator } from './conversation-coordinator'

describe('ConversationCoordinator', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
    database = undefined
  })

  it('selects the earliest idle Agent in the channel workspace and starts a read-only conversation at the repository root', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    const review = fixture.createAgent('Review', 'review')
    fixture.setIdle(build, '2026-07-25T08:01:00.000Z')
    fixture.setIdle(review, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('请帮我分析这个问题。'))

    expect(fixture.runtime.starts).toHaveLength(1)
    expect(fixture.runtime.starts[0]).toMatchObject({
      mode: 'conversation',
      title: '频道 #general 对话',
      initialMessage: '请帮我分析这个问题。',
      worktreePath: fixture.repository.path,
      profile: expect.objectContaining({ runtime: 'opencode', command: 'review-runtime' }),
    })
  })

  it('gives an exact @mention precedence over another earlier idle Agent', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    const review = fixture.createAgent('Review', 'review')
    fixture.setIdle(build, '2026-07-25T08:01:00.000Z')
    fixture.setIdle(review, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@build 请看一下这个报错。'))

    expect(fixture.runtime.starts).toHaveLength(1)
    expect(fixture.runtime.starts[0]?.profile.command).toBe('build-runtime')
  })

  it('reuses an Agent session for the next channel turn', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('第一条消息。'))
    const runtimeTaskId = fixture.runtime.starts[0]!.taskId
    fixture.runtime.emit(runtimeTaskId, { kind: 'text', text: '第一条回复。' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'settled' })

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('第二条消息。'))

    expect(fixture.runtime.starts).toHaveLength(1)
    expect(fixture.runtime.inputs).toEqual([
      expect.objectContaining({ input: '第二条消息。' }),
    ])
  })

  it('persists one compact Agent reply on settle and excludes raw runtime artifacts from the channel', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('请说明现状。'))
    const runtimeTaskId = fixture.runtime.starts[0]!.taskId
    fixture.runtime.emit(runtimeTaskId, { kind: 'artifact', artifactType: 'runtime-jsonl', content: '{"secret":"raw runtime output"}\n' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'artifact', artifactType: 'runtime-stderr', content: 'verbose process log' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'text', text: '目前接口返回正常，' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'text', text: '下一步建议检查边界条件。' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'settled' })

    const replies = fixture.channelMessages().filter((message) => message.senderType === 'agent')
    expect(replies).toEqual([
      expect.objectContaining({
        taskId: null,
        authorName: 'Build',
        body: '目前接口返回正常，下一步建议检查边界条件。',
      }),
    ])
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).not.toContain('raw runtime output')
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).not.toContain('verbose process log')
  })

  it('still acknowledges a settled turn that produced no displayable text', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('收到吗？'))
    fixture.runtime.emit(fixture.runtime.starts[0]!.taskId, { kind: 'settled' })

    expect(fixture.channelMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ senderType: 'agent', authorName: 'Build', body: '我已处理这条消息，但没有生成可展示的回复。' }),
    ]))
  })

  it('posts a concise Agent-authored failure and releases the Agent when the runtime errors', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('能回复吗？'))
    fixture.runtime.emit(fixture.runtime.starts[0]!.taskId, { kind: 'error', message: 'runtime unavailable' })

    expect(fixture.channelMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ senderType: 'agent', authorName: 'Build', body: '抱歉，我暂时无法回复：runtime unavailable' }),
    ]))
    expect(fixture.repositories.getAgent(build.id)?.status).toBe('idle')
  })

  async function createFixture() {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-conversation-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({
      workspaceId: workspace.id,
      name: 'demo',
      path: '/workspace/demo',
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'general' })
    const runtime = new FakeRuntimeAdapter()
    const messages = new ChannelMessageService(repositories)
    const coordinator = new ConversationCoordinator({
      repositories,
      runtimes: { opencode: runtime, pi: runtime, 'claude-code': runtime },
      messages,
    })

    const createAgent = (identity: string, mentionName: string): Agent => repositories.createAgent({
      workspaceId: workspace.id,
      identity,
      mentionName,
      runtime: 'opencode',
      capabilityTags: [],
      maxConcurrentTasks: 1,
      command: `${mentionName}-runtime`,
      args: [],
      model: '',
      env: {},
    })
    const setIdle = (agent: Agent, occurredAt: string) => repositories.setAgentStatus(agent.id, 'idle', new Date(occurredAt))
    const postHuman = (body: string) => messages.postHuman(channel.id, body)
    const channelMessages = () => repositories.getBootstrap().workspaces[0]!.recentMessages.filter((message) => message.channelId === channel.id)

    return { repositories, repository, channel, runtime, coordinator, createAgent, setIdle, postHuman, channelMessages }
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
