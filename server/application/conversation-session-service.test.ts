import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { Agent } from '../domain/agent'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../ports/runtime'
import type { RuntimeAvailability } from '../adapters/runtime/runtime-profile'
import {
  ConversationInvocationCancelledError,
  ConversationSessionService,
} from './conversation-session-service'

describe('ConversationSessionService', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
    database = undefined
  })

  it('resumes a persisted Runtime Session before sending input and retains it after settle', async () => {
    const fixture = await createFixture()
    const key = `${fixture.channelId}:timeline:${fixture.agent.id}`
    fixture.repositories.upsertConversationSession({
      key,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agent.id,
      runtime: fixture.agent.runtime,
      runtimeSessionId: 'persisted-session',
      runtimeSessionFile: '/tmp/persisted-session.json',
      status: 'ready',
      lastMessageId: null,
    })

    const firstInput = fixture.invocation('first input')
    const secondInput = fixture.invocation('second input')
    const first = await fixture.service.invoke(firstInput)
    const second = await fixture.service.invoke(secondInput)

    expect(fixture.runtime.order).toEqual(['resume:persisted-session', 'send:first input', 'send:second input'])
    expect(fixture.runtime.order.join('\n')).not.toContain('earlier context')
    expect(fixture.runtime.resumedWorktreeExists).toEqual([true])
    expect(fixture.runtime.starts).toHaveLength(0)
    expect(first.text).toBe('reply:first input')
    expect(second.text).toBe('reply:second input')
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      runtimeSessionId: 'persisted-session',
      runtimeSessionFile: '/tmp/persisted-session.json',
      status: 'ready',
      lastMessageId: secondInput.currentMessageId,
    })
  })

  it('invalidates every cached Agent session so the next invocation cold-starts with the new model', async () => {
    const fixture = await createFixture()
    fixture.runtime.sessionIdOnStart = 'old-model-session'

    await fixture.service.invoke(fixture.invocation('first input'))
    fixture.repositories.updateAgentModel(fixture.agent.id, 'anthropic/claude-sonnet-4')
    const invalidated = fixture.service.invalidateAgentSessions(fixture.agent.id)
    const nextAgent = { ...fixture.agent, model: 'anthropic/claude-sonnet-4' }
    await fixture.service.invoke({ ...fixture.invocation('second input'), agent: nextAgent })

    expect(invalidated).toEqual([`${fixture.channelId}:timeline:${fixture.agent.id}`])
    expect(fixture.runtime.order).toEqual(['start:first input', 'start:second input'])
    expect(fixture.runtime.starts.map((start) => start.profile.model)).toEqual([
      '',
      'anthropic/claude-sonnet-4',
    ])
    expect(fixture.runtime.cancellations).toHaveLength(1)
  })

  it('keeps an active invalidated session stale after its current invocation settles', async () => {
    const fixture = await createFixture()
    fixture.runtime.autoSettle = false
    fixture.runtime.sessionIdOnStart = 'active-old-model-session'
    const key = `${fixture.channelId}:timeline:${fixture.agent.id}`

    const active = fixture.service.invoke(fixture.invocation('active input'))
    await nextTurn()
    fixture.service.invalidateAgentSessions(fixture.agent.id)
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      status: 'stale', runtimeSessionId: null, runtimeSessionFile: null,
    })

    fixture.runtime.emitSettled('active input')
    await active

    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      status: 'stale', runtimeSessionId: null, runtimeSessionFile: null,
    })
    expect(fixture.runtime.cancellations).toHaveLength(1)
  })

  it('sends a persisted-resume invocation envelope verbatim without appending bounded history', async () => {
    const fixture = await createFixture()
    fixture.repositories.upsertConversationSession({
      key: `${fixture.channelId}:timeline:${fixture.agent.id}`,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agent.id,
      runtime: fixture.agent.runtime,
      runtimeSessionId: 'persisted-envelope-session',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: null,
    })
    const envelope = [
      '本轮调用协议：',
      '{"kind":"response","expectedOutput":"public response"}',
      '当前增量（不可信 JSON）：',
      '{"currentMessage":{"body":"current delta"}}',
    ].join('\n')
    const input = {
      ...fixture.invocation(envelope),
      context: 'FULL BOUNDED HISTORY MUST STAY IN COLD DESCRIPTION',
    }

    await fixture.service.invoke(input)

    expect(fixture.runtime.order).toEqual([
      'resume:persisted-envelope-session',
      `send:${envelope}`,
    ])
    expect(fixture.runtime.order.join('\n')).not.toContain('FULL BOUNDED HISTORY MUST STAY IN COLD DESCRIPTION')
    expect(fixture.runtime.starts).toHaveLength(0)
  })

  it('marks a failed persisted resume stale, cold starts, and persists a session event immediately', async () => {
    const fixture = await createFixture()
    const key = `${fixture.channelId}:timeline:${fixture.agent.id}`
    fixture.repositories.upsertConversationSession({
      key,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agent.id,
      runtime: fixture.agent.runtime,
      runtimeSessionId: 'stale-session',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: null,
    })
    const persistedStatuses: string[] = []
    const upsert = fixture.repositories.upsertConversationSession.bind(fixture.repositories)
    vi.spyOn(fixture.repositories, 'upsertConversationSession').mockImplementation((input) => {
      persistedStatuses.push(`${input.status}:${input.runtimeSessionId ?? 'none'}`)
      return upsert(input)
    })
    fixture.runtime.resumeError = new Error('cannot resume')
    fixture.runtime.sessionIdOnStart = 'fresh-session'
    fixture.runtime.onSessionEvent = () => {
      expect(fixture.repositories.getConversationSession(key)).toMatchObject({
        runtimeSessionId: 'fresh-session',
        status: 'active',
      })
    }

    const input = fixture.invocation('cold input')
    const result = await fixture.service.invoke(input)

    expect(result.text).toBe('reply:cold input')
    expect(fixture.runtime.order).toEqual(['resume:stale-session', 'start:cold input'])
    expect(fixture.runtime.starts[0]).toMatchObject({
      initialMessage: 'cold input',
      description: expect.stringContaining('近期公开消息：\nYou: earlier context'),
    })
    expect(persistedStatuses).toContain('stale:stale-session')
    expect(persistedStatuses).toContain('active:fresh-session')
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      runtimeSessionId: 'fresh-session',
      status: 'ready',
      lastMessageId: input.currentMessageId,
    })
  })

  it('self-heals a lost native Runtime Session reported after resumed input is sent', async () => {
    const fixture = await createFixture()
    const key = `${fixture.channelId}:timeline:${fixture.agent.id}`
    fixture.repositories.upsertConversationSession({
      key,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agent.id,
      runtime: fixture.agent.runtime,
      runtimeSessionId: 'lost-native-session',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: null,
    })
    const persistedStatuses: string[] = []
    const upsert = fixture.repositories.upsertConversationSession.bind(fixture.repositories)
    vi.spyOn(fixture.repositories, 'upsertConversationSession').mockImplementation((input) => {
      persistedStatuses.push(`${input.status}:${input.runtimeSessionId ?? 'none'}`)
      return upsert(input)
    })
    fixture.runtime.sessionLostOnSend = true
    fixture.runtime.sessionIdOnStart = 'fresh-native-session'

    const input = fixture.invocation('recover after native loss')
    const result = await fixture.service.invoke(input)

    expect(result.text).toBe('reply:recover after native loss')
    expect(fixture.runtime.order).toEqual([
      'resume:lost-native-session',
      'send:recover after native loss',
      'start:recover after native loss',
    ])
    expect(fixture.runtime.starts).toHaveLength(1)
    expect(persistedStatuses).toContain('stale:lost-native-session')
    expect(persistedStatuses).toContain('active:fresh-native-session')
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      runtimeSessionId: 'fresh-native-session',
      status: 'ready',
      lastMessageId: input.currentMessageId,
    })
  })

  it('returns the strict parsed protocol result with the displayable text', async () => {
    const fixture = await createFixture()
    fixture.runtime.responseFor = () => JSON.stringify({ reply: 'public answer', handoffTo: [] })

    const result = await fixture.service.invoke({
      ...fixture.invocation('question'),
      conversation: {
        turnId: 'turn-1',
        invocationId: 'invocation-1',
        kind: 'response',
        expectedOutput: 'public_response',
      },
    })

    expect(result).toEqual({
      text: 'public answer',
      parsed: { reply: 'public answer', handoffTo: [] },
    })
  })

  it('does not cold start after a resumed Session rejects sendInput', async () => {
    const fixture = await createFixture()
    const key = `${fixture.channelId}:timeline:${fixture.agent.id}`
    fixture.repositories.upsertConversationSession({
      key,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agent.id,
      runtime: fixture.agent.runtime,
      runtimeSessionId: 'persisted-session',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: null,
    })
    fixture.runtime.sendError = new Error('send failed')

    await expect(fixture.service.invoke(fixture.invocation('input that must not be duplicated')))
      .rejects.toThrow('send failed')

    expect(fixture.runtime.starts).toHaveLength(0)
    expect(fixture.repositories.getConversationSession(key)?.status).toBe('failed')
  })

  it('keeps a Runtime Session active when cancellation fails so cancellation can be retried', async () => {
    const fixture = await createFixture()
    fixture.runtime.autoSettle = false
    const invocation = fixture.service.invoke(fixture.invocation('long input'))
    const invocationFailure = invocation.catch((error: unknown) => error)
    await nextTurn()
    fixture.runtime.cancelError = new Error('runtime cancellation failed')

    await expect(fixture.service.cancelAgentInChannel(fixture.channelId, fixture.agent.id))
      .rejects.toThrow('runtime cancellation failed')
    expect(fixture.repositories.getConversationSession(`${fixture.channelId}:timeline:${fixture.agent.id}`)?.status).toBe('active')

    fixture.runtime.cancelError = undefined
    await fixture.service.cancelAgentInChannel(fixture.channelId, fixture.agent.id)

    expect(fixture.runtime.cancellations).toHaveLength(1)
    await expect(invocationFailure).resolves.toMatchObject({ message: 'Conversation invocation was cancelled.' })
  })

  it('keeps an in-memory invocation retryable when stale persistence fails', async () => {
    const fixture = await createFixture()
    fixture.runtime.autoSettle = false
    const invocation = fixture.service.invoke({
      ...fixture.invocation('retry stale persistence'),
      conversation: conversation('turn-retry', 'invocation-retry'),
    })
    const invocationFailure = invocation.catch((error: unknown) => error)
    await nextTurn()
    const upsert = fixture.repositories.upsertConversationSession.bind(fixture.repositories)
    let failStale = true
    vi.spyOn(fixture.repositories, 'upsertConversationSession').mockImplementation((input) => {
      if (input.status === 'stale' && failStale) throw new Error('stale persistence failed')
      return upsert(input)
    })

    await expect(fixture.service.cancelInvocation('invocation-retry'))
      .rejects.toThrow('stale persistence failed')
    expect(fixture.repositories.getConversationSession(`${fixture.channelId}:timeline:${fixture.agent.id}`)?.status)
      .toBe('active')

    failStale = false
    await expect(fixture.service.cancelInvocation('invocation-retry')).resolves.toEqual({
      invocationId: 'invocation-retry',
      cancelledSessionKeys: [`${fixture.channelId}:timeline:${fixture.agent.id}`],
    })

    expect(fixture.runtime.cancellations).toHaveLength(1)
    expect(fixture.repositories.getConversationSession(`${fixture.channelId}:timeline:${fixture.agent.id}`)?.status)
      .toBe('stale')
    await expect(invocationFailure).resolves.toBeInstanceOf(ConversationInvocationCancelledError)
  })

  it('cancels only the Runtime owned by one invocation when the same Agent has two active Turns', async () => {
    const fixture = await createFixture()
    fixture.runtime.autoSettle = false
    const inputA = {
      ...fixture.invocation('turn A'),
      conversation: conversation('turn-a', 'invocation-a'),
    }
    const inputB = {
      ...fixture.invocation('turn B'),
      threadRootMessageId: inputA.currentMessageId,
      conversation: conversation('turn-b', 'invocation-b'),
    }
    const invocationA = fixture.service.invoke(inputA)
    const invocationB = fixture.service.invoke(inputB)
    const failureA = invocationA.catch((error: unknown) => error)
    let invocationBSettled = false
    void invocationB.then(
      () => { invocationBSettled = true },
      () => { invocationBSettled = true },
    )
    await nextTurn()

    await expect(fixture.service.cancelInvocation('invocation-a')).resolves.toEqual({
      invocationId: 'invocation-a',
      cancelledSessionKeys: [`${fixture.channelId}:timeline:${fixture.agent.id}`],
    })

    await expect(failureA).resolves.toEqual(expect.objectContaining({
      name: 'ConversationInvocationCancelledError',
      invocationId: 'invocation-a',
    }))
    expect(fixture.runtime.cancellations.map((session) => session.taskId)).toEqual([
      fixture.runtime.starts[0]!.taskId,
    ])
    expect(invocationBSettled).toBe(false)

    await fixture.service.cancelInvocation('invocation-b')
    await expect(invocationB).rejects.toBeInstanceOf(ConversationInvocationCancelledError)
  })

  it('returns cancellation intent without waiting for a pending Runtime start', async () => {
    const fixture = await createFixture()
    const startGate = deferred<void>()
    fixture.runtime.autoSettle = false
    fixture.runtime.startGate = startGate.promise
    const invocation = fixture.service.invoke(fixture.invocation('slow start'))
    const invocationFailure = invocation.catch((error: unknown) => error)
    let cancellationSettled = false

    const cancellation = fixture.service.cancelChannel(fixture.channelId).then(() => {
      cancellationSettled = true
    })
    await nextTurn()
    const settledBeforeStartCompleted = cancellationSettled
    startGate.resolve()
    await cancellation
    await nextTurn()

    expect(settledBeforeStartCompleted).toBe(true)
    expect(fixture.runtime.cancellations).toHaveLength(1)
    await expect(invocationFailure).resolves.toMatchObject({ message: 'Conversation invocation was cancelled.' })
  })

  it('cancels a resumed Session immediately without waiting for resume to finish', async () => {
    const fixture = await createFixture()
    const resumeGate = deferred<void>()
    fixture.runtime.autoSettle = false
    fixture.runtime.resumeGate = resumeGate.promise
    fixture.repositories.upsertConversationSession({
      key: `${fixture.channelId}:timeline:${fixture.agent.id}`,
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: fixture.agent.id,
      runtime: fixture.agent.runtime,
      runtimeSessionId: 'resuming-session',
      runtimeSessionFile: null,
      status: 'ready',
      lastMessageId: null,
    })
    const invocation = fixture.service.invoke(fixture.invocation('cancel while resuming'))
    const invocationFailure = invocation.catch((error: unknown) => error)

    await fixture.service.cancelAgentInChannel(fixture.channelId, fixture.agent.id)

    expect(fixture.runtime.cancellations).toHaveLength(1)
    expect(fixture.runtime.order).toEqual(['resume:resuming-session'])
    resumeGate.resolve()
    await nextTurn()
    expect(fixture.runtime.order).not.toContain('send:cancel while resuming')
    await expect(invocationFailure).resolves.toMatchObject({ message: 'Conversation invocation was cancelled.' })
  })

  it('rejects a settled invocation with the persistence failure even when its error observer throws', async () => {
    const fixture = await createFixture()
    const upsert = fixture.repositories.upsertConversationSession.bind(fixture.repositories)
    vi.spyOn(fixture.repositories, 'upsertConversationSession').mockImplementation((input) => {
      if (input.status === 'ready') throw new Error('ready persistence failed')
      return upsert(input)
    })
    let outcome: unknown

    void fixture.service.invoke({
      ...fixture.invocation('settle with broken persistence'),
      onError: () => { throw new Error('error observer failed') },
    }).then(
      (result) => { outcome = result },
      (error: unknown) => { outcome = error },
    )
    await nextTurn()

    expect(outcome).toMatchObject({ message: 'ready persistence failed' })
  })

  it('rejects with an onSettled failure even when onError also throws', async () => {
    const fixture = await createFixture()

    await expect(fixture.service.invoke({
      ...fixture.invocation('settle with broken observers'),
      onSettled: () => { throw new Error('settled observer failed') },
      onError: () => { throw new Error('error observer failed') },
    })).rejects.toThrow('settled observer failed')
  })

  it('preserves a Runtime failure when failed persistence and onError both throw', async () => {
    const fixture = await createFixture()
    fixture.runtime.errorOnStart = new Error('runtime primary failure')
    const upsert = fixture.repositories.upsertConversationSession.bind(fixture.repositories)
    vi.spyOn(fixture.repositories, 'upsertConversationSession').mockImplementation((input) => {
      if (input.status === 'failed') throw new Error('failed persistence secondary')
      return upsert(input)
    })
    let outcome: unknown

    void fixture.service.invoke({
      ...fixture.invocation('runtime failure'),
      onError: () => { throw new Error('error observer secondary') },
    }).then(
      (result) => { outcome = result },
      (error: unknown) => { outcome = error },
    )
    await nextTurn()

    expect(outcome).toMatchObject({ message: 'runtime primary failure' })
  })

  it.each(['settled', 'error'] as const)('suppresses a synchronous Runtime %s event during cancellation bookkeeping', async (cancelEvent) => {
    const fixture = await createFixture()
    fixture.runtime.autoSettle = false
    fixture.runtime.cancelEvent = cancelEvent
    let settledCalls = 0
    const invocation = fixture.service.invoke({
      ...fixture.invocation('cancel race'),
      onSettled: () => { settledCalls += 1 },
    })
    const invocationFailure = invocation.catch((error: unknown) => error)
    await nextTurn()

    await fixture.service.cancelAgentInChannel(fixture.channelId, fixture.agent.id)

    expect(settledCalls).toBe(0)
    await expect(invocationFailure).resolves.toMatchObject({ message: 'Conversation invocation was cancelled.' })
    expect(fixture.repositories.getConversationSession(`${fixture.channelId}:timeline:${fixture.agent.id}`)?.status).toBe('stale')
  })

  it.each([
    ['B then A', [1, 0]],
    ['A then B', [0, 1]],
  ] as const)('isolates a replacement cold start when cancelled generation A resolves %s', async (_order, resolutionOrder) => {
    const fixture = await createFixture()
    const runtime = new AdversarialStartRuntime()
    const service = new ConversationSessionService({
      repositories: fixture.repositories,
      runtimes: { opencode: runtime },
      conversationDirectory: fixture.conversationDirectory,
    })
    let aSettledCalls = 0
    let bSettledCalls = 0
    const invocationA = service.invoke({
      ...fixture.invocation('invocation A'),
      onSettled: () => { aSettledCalls += 1 },
    })
    const invocationAFailure = invocationA.catch((error: unknown) => error)

    expect(runtime.starts).toHaveLength(1)
    await service.cancelAgentInChannel(fixture.channelId, fixture.agent.id)
    await expect(invocationAFailure).resolves.toMatchObject({ message: 'Conversation invocation was cancelled.' })

    const invocationB = service.invoke({
      ...fixture.invocation('invocation B'),
      onSettled: () => { bSettledCalls += 1 },
    })
    expect(runtime.starts).toHaveLength(2)

    for (const index of resolutionOrder) runtime.resolveStart(index, index === 0 ? 'session-a' : 'session-b')
    await nextTurn()

    runtime.emitText(0, 'text from A')
    runtime.emitSettled(0)
    runtime.emitSettled(0)
    runtime.emitText(1, 'text from B')
    runtime.emitSettled(1)
    runtime.emitSettled(1)

    await expect(invocationB).resolves.toEqual({ text: 'text from B', parsed: null })
    expect(runtime.starts[0]?.taskId).not.toBe(runtime.starts[1]?.taskId)
    expect(runtime.cancellations.map((session) => session.sessionId)).toEqual(['session-a'])
    expect(aSettledCalls).toBe(0)
    expect(bSettledCalls).toBe(1)
    expect(fixture.repositories.getConversationSession(`${fixture.channelId}:timeline:${fixture.agent.id}`)).toMatchObject({
      runtimeSessionId: 'session-b',
      status: 'ready',
    })
  })

  async function createFixture() {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-session-'))
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
      identity: 'Build', mentionName: 'build', runtime: 'opencode', capabilityTags: ['build'],
      responsibilities: ['构建'], maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: {},
    })
    const runtime = new RecordingRuntime()
    const conversationDirectory = path.join(temporaryDirectory, 'conversations')
    const service = new ConversationSessionService({
      repositories,
      runtimes: { opencode: runtime },
      conversationDirectory,
    })
    return {
      repositories,
      channelId: channel.id,
      agent,
      runtime,
      service,
      conversationDirectory,
      invocation(initialMessage: string) {
        const currentMessage = repositories.createMessage({
          channelId: channel.id,
          senderType: 'human',
          authorName: 'You',
          body: initialMessage,
        })
        return {
          channelId: channel.id,
          threadRootMessageId: null,
          currentMessageId: currentMessage.id,
          agent,
          context: '近期公开消息：\nYou: earlier context',
          initialMessage,
        }
      },
    }
  }
})

class AdversarialStartRuntime implements RuntimeAdapter {
  readonly starts: RuntimeTaskRequest[] = []
  readonly cancellations: RuntimeSession[] = []
  private readonly pending: Array<{
    task: RuntimeTaskRequest
    sink: RuntimeEventSink
    resolve(session: RuntimeSession): void
  }> = []

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve({ executable: 'available', taskExecution: 'unverified' })
  }

  start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.starts.push(task)
    return new Promise<RuntimeSession>((resolve) => {
      this.pending.push({ task, sink, resolve })
    })
  }

  resume(_session: RuntimeSession, _sink: RuntimeEventSink): Promise<void> {
    return Promise.resolve()
  }

  sendInput(_session: RuntimeSession, _input: string, _sink: RuntimeEventSink): void {}

  cancel(session: RuntimeSession): void {
    this.cancellations.push(session)
  }

  resolveStart(index: number, sessionId: string): void {
    const pending = this.pending[index]
    if (!pending) throw new Error(`Runtime start ${index} does not exist.`)
    pending.resolve(runtimeSession(pending.task, sessionId))
  }

  emitText(index: number, text: string): void {
    const pending = this.pending[index]
    if (!pending) throw new Error(`Runtime start ${index} does not exist.`)
    pending.sink({ kind: 'text', taskId: pending.task.taskId, text })
  }

  emitSettled(index: number): void {
    const pending = this.pending[index]
    if (!pending) throw new Error(`Runtime start ${index} does not exist.`)
    pending.sink({ kind: 'settled', taskId: pending.task.taskId })
  }
}

class RecordingRuntime implements RuntimeAdapter {
  readonly starts: RuntimeTaskRequest[] = []
  readonly order: string[] = []
  readonly cancellations: RuntimeSession[] = []
  readonly resumedWorktreeExists: boolean[] = []
  resumeError: Error | undefined
  sendError: Error | undefined
  cancelError: Error | undefined
  errorOnStart: Error | undefined
  sessionLostOnSend = false
  cancelEvent: 'settled' | 'error' | undefined
  startGate: Promise<void> | undefined
  resumeGate: Promise<void> | undefined
  sessionIdOnStart: string | undefined
  autoSettle = true
  onSessionEvent: (() => void) | undefined
  responseFor = (input: string) => `reply:${input}`
  private sink: RuntimeEventSink | undefined
  private taskId: string | undefined

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve({ executable: 'available', taskExecution: 'unverified' })
  }

  async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.starts.push(task)
    this.order.push(`start:${task.initialMessage ?? ''}`)
    this.sink = sink
    this.taskId = task.taskId
    const session = runtimeSession(task, this.sessionIdOnStart ?? null)
    if (this.startGate) await this.startGate
    if (this.sessionIdOnStart) {
      sink({ kind: 'session', taskId: task.taskId, sessionId: this.sessionIdOnStart, sessionFile: '/tmp/fresh-session.json' })
      this.onSessionEvent?.()
    }
    if (this.errorOnStart) {
      queueMicrotask(() => sink({ kind: 'error', taskId: task.taskId, message: this.errorOnStart!.message }))
    } else if (this.autoSettle) {
      queueMicrotask(() => this.settle(task.taskId, task.initialMessage ?? '', sink))
    }
    return session
  }

  async resume(session: RuntimeSession, _sink: RuntimeEventSink): Promise<void> {
    this.order.push(`resume:${session.sessionId ?? 'none'}`)
    this.resumedWorktreeExists.push(existsSync(session.worktreePath))
    if (this.resumeGate) await this.resumeGate
    if (this.resumeError) throw this.resumeError
  }

  sendInput(session: RuntimeSession, input: string, sink: RuntimeEventSink): void {
    this.order.push(`send:${input}`)
    if (this.sendError) throw this.sendError
    if (this.sessionLostOnSend) {
      this.sessionLostOnSend = false
      sink({ kind: 'error', taskId: session.taskId, message: 'native session not found', errorCode: 'session_lost' })
      return
    }
    if (this.autoSettle) queueMicrotask(() => this.settle(session.taskId, input, sink))
  }

  cancel(session: RuntimeSession): void {
    if (this.cancelEvent === 'settled') this.sink?.({ kind: 'settled', taskId: this.taskId! })
    if (this.cancelEvent === 'error') this.sink?.({ kind: 'error', taskId: this.taskId!, message: 'synchronous cancel error event' })
    if (this.cancelError) throw this.cancelError
    this.cancellations.push(session)
  }

  emitSettled(input: string): void {
    if (!this.taskId || !this.sink) throw new Error('Runtime has not started.')
    this.settle(this.taskId, input, this.sink)
  }

  private settle(taskId: string, input: string, sink: RuntimeEventSink): void {
    sink({ kind: 'text', taskId, text: this.responseFor(input) })
    sink({ kind: 'settled', taskId })
  }
}

function runtimeSession(task: RuntimeTaskRequest, sessionId: string | null): RuntimeSession {
  return {
    taskId: task.taskId,
    runtime: task.profile.runtime,
    worktreePath: task.worktreePath,
    profile: task.profile,
    sessionId,
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function conversation(turnId: string, invocationId: string) {
  return {
    turnId,
    invocationId,
    kind: 'response' as const,
    expectedOutput: 'public_response' as const,
  }
}
