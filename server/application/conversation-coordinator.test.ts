import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
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

  it('selects the Agent whose responsibility matches an unmentioned channel message', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build', ['构建与发布'])
    const review = fixture.createAgent('Review', 'review', ['前端界面与交互'])
    fixture.setIdle(build, '2026-07-25T08:01:00.000Z')
    fixture.setIdle(review, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('请调整这个界面的交互。'))

    expect(fixture.runtime.starts).toHaveLength(1)
    expect(fixture.runtime.starts[0]).toMatchObject({
      mode: 'conversation',
      title: '频道 #general 对话',
      initialMessage: '请调整这个界面的交互。',
      worktreePath: path.join(fixture.conversationDirectory, fixture.channel.id, review.id),
      profile: expect.objectContaining({ runtime: 'opencode', command: 'review-runtime' }),
    })
  })

  it('does not assign an unmentioned message when no idle Agent responsibility matches it', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build', ['构建与发布'])
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('周末去哪里旅行比较好？'))

    expect(fixture.runtime.starts).toHaveLength(0)
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

  it('routes an Agent display name before its legacy mention handle', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('clawd', 'build')
    const review = fixture.createAgent('newton', 'dev')
    fixture.setIdle(build, '2026-07-25T08:01:00.000Z')
    fixture.setIdle(review, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@clawd 请看一下这个报错。'))

    expect(fixture.runtime.starts[0]?.profile.command).toBe('build-runtime')
  })

  it('runs a global mentioned Agent in a neutral service-owned conversation directory', async () => {
    const fixture = await createFixture()
    const remote = fixture.createRemoteAgent('Release', 'release')
    fixture.setIdle(remote.agent, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@Release 请检查发布配置。'))

    expect(fixture.runtime.starts[0]).toMatchObject({
      worktreePath: path.join(fixture.conversationDirectory, fixture.channel.id, remote.agent.id),
      profile: expect.objectContaining({ command: 'release-runtime' }),
    })
    expect((await stat(path.join(fixture.conversationDirectory, fixture.channel.id, remote.agent.id))).isDirectory()).toBe(true)
  })

  it('does not route an ordinary channel message to an Agent outside its membership', async () => {
    const fixture = await createFixture()
    const outsider = fixture.createOutsiderAgent('Outsider', 'outsider')
    fixture.setIdle(outsider, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@Outsider 请回答。'))

    expect(fixture.runtime.starts).toHaveLength(0)
  })

  it('routes summit messages to every global Agent without persisted membership rows', async () => {
    const fixture = await createFixture()
    const summit = fixture.repositories.createChannel({ name: 'summit', systemKey: 'summit' })
    const outsider = fixture.createOutsiderAgent('Outsider', 'outsider')
    fixture.setIdle(outsider, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(summit.id, fixture.postHumanIn(summit.id, '@Outsider 请回答。'))

    expect(fixture.runtime.starts).toEqual([
      expect.objectContaining({
        worktreePath: path.join(fixture.conversationDirectory, summit.id, outsider.id),
        profile: expect.objectContaining({ command: 'outsider-runtime' }),
      }),
    ])
  })

  it('recognizes an Agent mention directly after Chinese text', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    const review = fixture.createAgent('Review', 'review')
    fixture.setIdle(build, '2026-07-25T08:01:00.000Z')
    fixture.setIdle(review, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('请帮我看看@build'))

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

  it('exposes a typing Agent only while it is preparing a channel reply', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('请检查这个问题。'))
    expect(fixture.coordinator.getTypingAgentIds(fixture.channel.id)).toEqual([build.id])

    fixture.runtime.emit(fixture.runtime.starts[0]!.taskId, { kind: 'settled' })
    expect(fixture.coordinator.getTypingAgentIds(fixture.channel.id)).toEqual([])
  })

  it('cancels an active channel conversation without posting a cancellation reply', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('请检查这个问题。'))
    const runtimeTaskId = fixture.runtime.starts[0]!.taskId
    await fixture.coordinator.cancelChannel(fixture.channel.id)
    fixture.runtime.emit(runtimeTaskId, { kind: 'text', text: '不应显示。' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'settled' })

    expect(fixture.runtime.cancellations.map((session) => session.taskId)).toEqual([runtimeTaskId])
    expect(fixture.coordinator.getTypingAgentIds(fixture.channel.id)).toEqual([])
    expect(fixture.repositories.getAgent(build.id)?.status).toBe('idle')
    expect(fixture.channelMessages().filter((message) => message.senderType === 'agent')).toEqual([])
  })

  it('cancels only the targeted Agent conversations in one channel', async () => {
    const fixture = await createFixture()
    const planning = fixture.repositories.createChannel({ name: 'planning' })
    const build = fixture.createAgent('Build', 'build')
    const review = fixture.createAgent('Review', 'review')
    fixture.repositories.addChannelAgent(planning.id, build.id, new Date())
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')
    fixture.setIdle(review, '2026-07-25T08:01:00.000Z')

    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@Build 请检查构建。'))
    const targetedRuntimeTaskId = fixture.runtime.starts[0]!.taskId
    fixture.setIdle(build, '2026-07-25T08:02:00.000Z')
    await fixture.coordinator.dispatch(planning.id, fixture.postHumanIn(planning.id, '@Build 请规划发布。'))
    const otherChannelRuntimeTaskId = fixture.runtime.starts[1]!.taskId
    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@Review 请检查界面。'))
    const otherAgentRuntimeTaskId = fixture.runtime.starts[2]!.taskId

    await fixture.coordinator.cancelAgentInChannel(fixture.channel.id, build.id)
    await fixture.coordinator.cancelAgentInChannel(fixture.channel.id, build.id)

    expect(fixture.runtime.cancellations.map((session) => session.taskId)).toEqual([targetedRuntimeTaskId])
    expect(fixture.coordinator.getTypingAgentIds(fixture.channel.id)).toEqual([review.id])
    expect(fixture.coordinator.getTypingAgentIds(planning.id)).toEqual([build.id])
    expect(fixture.repositories.getAgent(build.id)?.status).toBe('busy')
    expect(otherChannelRuntimeTaskId).not.toBe(targetedRuntimeTaskId)
    expect(otherAgentRuntimeTaskId).not.toBe(targetedRuntimeTaskId)
  })

  it('keeps a failed runtime cancellation tracked and busy so it can be retried', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')
    await fixture.coordinator.dispatch(fixture.channel.id, fixture.postHuman('@Build 请检查构建。'))
    const cancel = fixture.runtime.cancel.bind(fixture.runtime)
    fixture.runtime.cancel = () => {
      throw new Error('runtime cancellation failed')
    }

    await expect(fixture.coordinator.cancelAgentInChannel(fixture.channel.id, build.id))
      .rejects.toThrow('runtime cancellation failed')

    expect(fixture.coordinator.getTypingAgentIds(fixture.channel.id)).toEqual([build.id])
    expect(fixture.repositories.getAgent(build.id)?.status).toBe('busy')

    fixture.runtime.cancel = cancel
    await fixture.coordinator.cancelAgentInChannel(fixture.channel.id, build.id)

    expect(fixture.runtime.cancellations).toHaveLength(1)
    expect(fixture.coordinator.getTypingAgentIds(fixture.channel.id)).toEqual([])
    expect(fixture.repositories.getAgent(build.id)?.status).toBe('idle')
  })

  it('keeps an Agent conversation and reply inside the triggering Thread', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')
    const root = fixture.postHuman('请讨论部署方案。')
    const threadMessage = fixture.postHuman('先看回滚策略。', root.id)

    await fixture.coordinator.dispatch(fixture.channel.id, threadMessage)
    fixture.runtime.emit(fixture.runtime.starts[0]!.taskId, { kind: 'text', text: '建议先保留可回滚版本。' })
    fixture.runtime.emit(fixture.runtime.starts[0]!.taskId, { kind: 'settled' })

    expect(fixture.runtime.starts[0]!.description).toContain('请讨论部署方案。')
    expect(fixture.channelMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorName: 'Build', threadRootMessageId: root.id, body: '建议先保留可回滚版本。' }),
    ]))
  })

  it('bounds long channel history before passing it to a runtime', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')
    for (let index = 0; index < 12; index += 1) fixture.postHuman(`历史消息-${index} ${'x'.repeat(900)}`)
    const current = fixture.postHuman('请基于频道上下文回答。')

    await fixture.coordinator.dispatch(fixture.channel.id, current)

    const context = fixture.runtime.starts[0]!.description
    expect(context).toContain('历史消息-11')
    expect(context).not.toContain('历史消息-0')
    expect(context.length).toBeLessThan(5_000)
  })

  it('uses the complete reset-aware Timeline instead of a fixed eight-message window', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')
    for (let index = 0; index < 12; index += 1) fixture.postHuman(`短历史消息-${index}`)
    const current = fixture.postHuman('请综合全部历史。')

    await fixture.coordinator.dispatch(fixture.channel.id, current)

    expect(fixture.runtime.starts[0]!.description).toContain('近期公开消息：')
    expect(fixture.runtime.starts[0]!.description).toContain('短历史消息-0')
    expect(fixture.runtime.starts[0]!.description).toContain('短历史消息-11')
  })

  it('persists Runtime session events and leaves the session ready after settle', async () => {
    const fixture = await createFixture()
    const build = fixture.createAgent('Build', 'build')
    fixture.setIdle(build, '2026-07-25T08:00:00.000Z')
    const current = fixture.postHuman('请检查 Session。')

    await fixture.coordinator.dispatch(fixture.channel.id, current)
    const runtimeTaskId = fixture.runtime.starts[0]!.taskId
    fixture.runtime.emit(runtimeTaskId, {
      kind: 'session',
      sessionId: 'runtime-session-1',
      sessionFile: '/tmp/runtime-session-1.json',
    })

    const key = `${fixture.channel.id}:timeline:${build.id}`
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      runtimeSessionId: 'runtime-session-1',
      runtimeSessionFile: '/tmp/runtime-session-1.json',
      status: 'active',
    })

    fixture.runtime.emit(runtimeTaskId, { kind: 'text', text: 'Session 正常。' })
    fixture.runtime.emit(runtimeTaskId, { kind: 'settled' })
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({ status: 'ready', lastMessageId: current.id })
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
    const channel = repositories.createChannel({ name: 'general' })
    const conversationDirectory = path.join(temporaryDirectory, 'conversations')
    const runtime = new FakeRuntimeAdapter()
    const messages = new ChannelMessageService(repositories)
    const coordinator = new ConversationCoordinator({
      repositories,
      runtimes: { opencode: runtime, pi: runtime, 'claude-code': runtime },
      messages,
      conversationDirectory,
    })

    const createOutsiderAgent = (identity: string, mentionName: string, responsibilities: string[] = ['通用回复']): Agent => {
      const agent = repositories.createAgent({
        identity,
        mentionName,
        runtime: 'opencode',
        capabilityTags: [],
        responsibilities,
        maxConcurrentTasks: 1,
        command: `${mentionName}-runtime`,
        args: [],
        model: '',
        env: {},
      })
      return agent
    }
    const createAgent = (identity: string, mentionName: string, responsibilities: string[] = ['通用回复']): Agent => {
      const agent = createOutsiderAgent(identity, mentionName, responsibilities)
      repositories.addChannelAgent(channel.id, agent.id, new Date())
      return agent
    }
    const createRemoteAgent = (identity: string, mentionName: string) => {
      const remoteWorkspace = repositories.createWorkspace({ name: 'Release' })
      const remoteRepository = repositories.createRepository({
        workspaceId: remoteWorkspace.id,
        name: 'release',
        path: '/workspace/release',
        currentBranch: 'main',
        defaultBranch: 'main',
        isClean: true,
      })
      const agent = repositories.createAgent({
        identity,
        mentionName,
        runtime: 'opencode',
        capabilityTags: [],
        responsibilities: ['发布'],
        maxConcurrentTasks: 1,
        command: `${mentionName}-runtime`,
        args: [],
        model: '',
        env: {},
      })
      repositories.addChannelAgent(channel.id, agent.id, new Date())
      return { agent, repository: remoteRepository }
    }
    const setIdle = (agent: Agent, occurredAt: string) => repositories.setAgentStatus(agent.id, 'idle', new Date(occurredAt))
    const postHuman = (body: string, threadRootMessageId?: string) => messages.postHuman(channel.id, body, null, threadRootMessageId)
    const postHumanIn = (channelId: string, body: string, threadRootMessageId?: string) => messages.postHuman(channelId, body, null, threadRootMessageId)
    const channelMessages = () => repositories.getBootstrap().recentMessages.filter((message) => message.channelId === channel.id)

    return {
      repositories, repository, channel, conversationDirectory, runtime, coordinator,
      createAgent, createOutsiderAgent, createRemoteAgent, setIdle, postHuman, postHumanIn, channelMessages,
    }
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
