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
import { ConversationSessionService } from './conversation-session-service'

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
    expect(persistedStatuses).toContain('stale:stale-session')
    expect(persistedStatuses).toContain('active:fresh-session')
    expect(fixture.repositories.getConversationSession(key)).toMatchObject({
      runtimeSessionId: 'fresh-session',
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
    const service = new ConversationSessionService({
      repositories,
      runtimes: { opencode: runtime },
      conversationDirectory: path.join(temporaryDirectory, 'conversations'),
    })
    return {
      repositories,
      channelId: channel.id,
      agent,
      runtime,
      service,
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

class RecordingRuntime implements RuntimeAdapter {
  readonly starts: RuntimeTaskRequest[] = []
  readonly order: string[] = []
  readonly cancellations: RuntimeSession[] = []
  readonly resumedWorktreeExists: boolean[] = []
  resumeError: Error | undefined
  sendError: Error | undefined
  cancelError: Error | undefined
  sessionIdOnStart: string | undefined
  autoSettle = true
  onSessionEvent: (() => void) | undefined
  responseFor = (input: string) => `reply:${input}`

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve({ executable: 'available', taskExecution: 'unverified' })
  }

  async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.starts.push(task)
    this.order.push(`start:${task.initialMessage ?? ''}`)
    const session = runtimeSession(task, this.sessionIdOnStart ?? null)
    if (this.sessionIdOnStart) {
      sink({ kind: 'session', taskId: task.taskId, sessionId: this.sessionIdOnStart, sessionFile: '/tmp/fresh-session.json' })
      this.onSessionEvent?.()
    }
    if (this.autoSettle) queueMicrotask(() => this.settle(task.taskId, task.initialMessage ?? '', sink))
    return session
  }

  async resume(session: RuntimeSession, _sink: RuntimeEventSink): Promise<void> {
    this.order.push(`resume:${session.sessionId ?? 'none'}`)
    this.resumedWorktreeExists.push(existsSync(session.worktreePath))
    if (this.resumeError) throw this.resumeError
  }

  sendInput(session: RuntimeSession, input: string, sink: RuntimeEventSink): void {
    this.order.push(`send:${input}`)
    if (this.sendError) throw this.sendError
    if (this.autoSettle) queueMicrotask(() => this.settle(session.taskId, input, sink))
  }

  cancel(session: RuntimeSession): void {
    if (this.cancelError) throw this.cancelError
    this.cancellations.push(session)
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
