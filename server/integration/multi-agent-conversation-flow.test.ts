import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../app'
import type { RuntimeAvailability } from '../adapters/runtime/runtime-profile'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../ports/runtime'
import type { WorkspaceRepositories } from '../ports/repositories'
import { conversationSessionKey } from '../application/conversation-session-service'
import { startHttpTestServer } from '../test/http-test-server'

describe('multi-agent conversation flow', () => {
  let dataDirectory: string | undefined
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
    dataDirectory = undefined
  })

  it('coordinates ordinary replies, restores persisted sessions, and falls back to cold context', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-conversation-flow-'))
    const databasePath = path.join(dataDirectory, 'sinapsis.sqlite')
    const runtime = new ScriptedConversationRuntime()
    const first = createApp({ databasePath, conversationRuntimes: { opencode: runtime } })
    const repositories = first.locals.repositories as WorkspaceRepositories
    const fixture = seedConversation(repositories, runtime)
    const firstServer = await startHttpTestServer(first)
    close = firstServer.close

    await postMessage(firstServer.baseUrl, fixture.channelId, 'incident needs an owner')

    const firstTurn = repositories.listActiveConversationTurns(fixture.channelId)
    expect(firstTurn).toEqual([])
    expect(runtime.calls.map((call) => call?.kind)).toEqual([
      'participation', 'participation', 'response', 'duplicate_check', 'response', 'handoff_response',
    ])
    expect(agentBodies(repositories, fixture.channelId)).toEqual(expect.arrayContaining([
      'Alpha public answer', 'Beta independent answer', 'Gamma handoff answer',
    ]))
    const firstTurnId = runtime.calls.find((call) => call?.kind === 'response')?.turnId
    expect(firstTurnId).toBeTruthy()
    expect(repositories.listConversationHandoffs(firstTurnId!)).toEqual([
      expect.objectContaining({ toAgentId: fixture.agentIds.gamma, round: 2, status: 'completed' }),
    ])
    expect(repositories.listAgentInvocations(firstTurnId!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: fixture.agentIds.gamma, kind: 'handoff_response', round: 2, status: 'settled' }),
    ]))
    const timelineSessionKey = conversationSessionKey(fixture.channelId, null, fixture.agentIds.alpha)
    const persistedTimelineSession = repositories.getConversationSession(timelineSessionKey)
    expect(persistedTimelineSession).toMatchObject({
      key: `${fixture.channelId}:timeline:${fixture.agentIds.alpha}`,
      runtimeSessionId: expect.stringMatching(/^session-/),
      status: 'ready',
    })

    await close()
    close = undefined
    const resumed = createApp({ databasePath, conversationRuntimes: { opencode: runtime } })
    const resumedRepositories = resumed.locals.repositories as WorkspaceRepositories
    const resumedServer = await startHttpTestServer(resumed)
    close = resumedServer.close

    const inputsBeforeResume = runtime.inputs.length
    await postMessage(resumedServer.baseUrl, fixture.channelId, '@Alpha second incident update')
    expect(runtime.resumes).toHaveLength(1)
    expect(runtime.resumes[0]?.sessionId).toBe(persistedTimelineSession?.runtimeSessionId)
    expect(runtime.inputs).toHaveLength(inputsBeforeResume + 1)
    expect(agentBodies(resumedRepositories, fixture.channelId).length).toBeGreaterThan(3)
    expect(runtime.calls).toContainEqual(expect.objectContaining({ kind: 'response' }))

    const threadRoot = resumedRepositories.createMessage({
      channelId: fixture.channelId,
      senderType: 'human',
      authorName: 'You',
      body: 'Thread-only root context',
    })
    await postMessage(resumedServer.baseUrl, fixture.channelId, 'incident thread first update', threadRoot.id)
    const threadSessionKey = conversationSessionKey(fixture.channelId, threadRoot.id, fixture.agentIds.alpha)
    await waitFor(() => resumedRepositories.getConversationSession(threadSessionKey)?.runtimeSessionId !== null)
    const persistedThreadSession = resumedRepositories.getConversationSession(threadSessionKey)
    expect(persistedThreadSession).toMatchObject({
      key: `${fixture.channelId}:${threadRoot.id}:${fixture.agentIds.alpha}`,
      runtimeSessionId: expect.stringMatching(/^session-/),
    })

    await close()
    close = undefined
    runtime.failNextResume = true
    const coldStarted = createApp({ databasePath, conversationRuntimes: { opencode: runtime } })
    const coldServer = await startHttpTestServer(coldStarted)
    close = coldServer.close

    await postMessage(coldServer.baseUrl, fixture.channelId, '@Alpha second thread update', threadRoot.id)
    await waitFor(() => coldStarted.locals.repositories.listActiveConversationTurns(fixture.channelId).length === 0)
    expect(runtime.resumes.at(-1)?.sessionId).toBe(persistedThreadSession?.runtimeSessionId)
    expect(runtime.requests.at(-1)?.description).toContain('Thread-only root context')
    expect(runtime.requests.at(-1)?.description).toContain('Alpha: Alpha public answer')
    expect(runtime.requests.at(-1)?.description).not.toContain('Alpha resumed answer')
    expect(runtime.requests.at(-1)?.description).not.toContain('RAW_RUNTIME_ARTIFACT')
    expect(coldStarted.locals.repositories.listMessagesForConversation(fixture.channelId, threadRoot.id)
      .filter((message: { senderType: string }) => message.senderType === 'agent').at(-1)).toMatchObject({
      threadRootMessageId: threadRoot.id,
    })
  })

  it('isolates a failed explicitly mentioned Agent without waking unmentioned members', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-conversation-multi-mention-'))
    const databasePath = path.join(dataDirectory, 'sinapsis.sqlite')
    const runtime = new ScriptedConversationRuntime({ failingMention: 'beta' })
    const app = createApp({ databasePath, conversationRuntimes: { opencode: runtime } })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const fixture = seedConversation(repositories, runtime)
    const server = await startHttpTestServer(app)
    close = server.close

    await postMessage(server.baseUrl, fixture.channelId, '@Alpha @Beta inspect explicitly')
    const turnId = runtime.calls.find((call) => call?.kind === 'response')?.turnId
    expect(turnId).toBeTruthy()
    expect(repositories.getConversationTurn(turnId!)).toMatchObject({ mode: 'multi_direct', status: 'partial' })
    expect(agentBodies(repositories, fixture.channelId)).toEqual(['Alpha public answer'])
    expect(runtime.requests.some((request) => request.worktreePath.endsWith(fixture.agentIds.gamma))).toBe(false)
    expect(repositories.listAgentInvocations(turnId!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: fixture.agentIds.alpha, status: 'settled' }),
      expect.objectContaining({ agentId: fixture.agentIds.beta, status: 'failed' }),
    ]))
  })

  it('isolates parallel failures and keeps Runtime artifacts out of public channel data', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-conversation-isolation-'))
    const databasePath = path.join(dataDirectory, 'sinapsis.sqlite')
    const runtime = new ScriptedConversationRuntime({ failingMention: 'beta' })
    const app = createApp({ databasePath, conversationRuntimes: { opencode: runtime } })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const fixture = seedConversation(repositories, runtime)
    const server = await startHttpTestServer(app)
    close = server.close

    const message = await postMessage(server.baseUrl, fixture.channelId, '@all inspect the incident')
    const turnId = runtime.requests.find((request) => request.conversation?.turnId && request.conversation.kind === 'response')?.conversation?.turnId
    expect(turnId).toBeTruthy()
    const details = await fetch(`${server.baseUrl}/api/channels/${fixture.channelId}/turns/${turnId}`)
      .then((response) => response.json()) as { turn: { status: string }; invocations: Array<{ status: string; errorCategory: string | null }> }

    expect(details.turn.status).toBe('partial')
    expect(details.invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed', errorCategory: 'runtime_failure' }),
      expect.objectContaining({ status: 'settled', errorCategory: null }),
    ]))
    expect(agentBodies(repositories, fixture.channelId).join('\n')).not.toContain('RAW_RUNTIME_ARTIFACT')
    expect(JSON.stringify(details)).not.toContain('RAW_RUNTIME_ARTIFACT')
  })

  it('atomically requeues an interrupted Invocation and resumes it on startup', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-conversation-recovery-'))
    const databasePath = path.join(dataDirectory, 'sinapsis.sqlite')
    const runtime = new ScriptedConversationRuntime()
    const app = createApp({ databasePath, conversationRuntimes: { opencode: runtime } })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const fixture = seedConversation(repositories, runtime)
    const alphaId = fixture.agentIds.alpha
    const message = repositories.createMessage({
      channelId: fixture.channelId,
      senderType: 'human',
      authorName: 'You',
      body: '@Alpha recover this invocation',
    })
    const turn = repositories.createConversationTurn({
      channelId: fixture.channelId,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: alphaId,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      status: 'selected',
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: alphaId,
      kind: 'response',
      priority: 'human_direct',
      round: 1,
      idempotencyKey: `${turn.id}:1:response:${alphaId}`,
      sourceInvocationId: null,
      status: 'running',
      startedAt: '2026-08-01T00:00:00.000Z',
    })
    repositories.upsertConversationSession({
      key: conversationSessionKey(fixture.channelId, null, alphaId),
      channelId: fixture.channelId,
      threadRootMessageId: null,
      agentId: alphaId,
      runtime: 'opencode',
      runtimeSessionId: 'persisted-session',
      runtimeSessionFile: null,
      status: 'active',
      lastMessageId: message.id,
    })

    await (app.locals.conversationCoordinator as { recover(): Promise<void> }).recover()
    await waitFor(() => repositories.getConversationTurn(turn.id)?.status === 'completed')

    expect(runtime.resumes).toHaveLength(1)
    expect(repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ id: invocation.id, status: 'settled' }),
    ])
  })
})

function seedConversation(repositories: WorkspaceRepositories, runtime: ScriptedConversationRuntime): { channelId: string; agentIds: Record<string, string> } {
  const workspace = repositories.createWorkspace({ name: 'Conversation integration' })
  repositories.createRepository({
    workspaceId: workspace.id,
    name: 'integration-repository',
    path: '/tmp/sinapsis-conversation-integration',
    currentBranch: 'main',
    defaultBranch: 'main',
    isClean: true,
  })
  const channel = repositories.createChannel({ name: `incident-${workspace.id}` })
  const agentIds: Record<string, string> = {}
  for (const [identity, mentionName] of [['Alpha', 'alpha'], ['Beta', 'beta'], ['Gamma', 'gamma']] as const) {
    const agent = repositories.createAgent({
      identity,
      mentionName,
      runtime: 'opencode',
      capabilityTags: mentionName === 'gamma' ? ['follow-up'] : ['incident'],
      responsibilities: mentionName === 'gamma' ? ['follow-up'] : ['incident'],
      maxConcurrentTasks: 1,
      command: 'fake',
      args: [],
      model: '',
      env: {},
    })
    repositories.setAgentStatus(agent.id, 'idle', new Date())
    repositories.addChannelAgent(channel.id, agent.id, new Date())
    runtime.register(agent.id, mentionName)
    agentIds[mentionName] = agent.id
  }
  return { channelId: channel.id, agentIds }
}

async function postMessage(
  baseUrl: string,
  channelId: string,
  body: string,
  threadRootMessageId?: string,
): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, ...(threadRootMessageId ? { threadRootMessageId } : {}) }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ id: string }>
}

function agentBodies(repositories: WorkspaceRepositories, channelId: string): string[] {
  return repositories.listMessagesForConversation(channelId, null)
    .filter((message) => message.senderType === 'agent')
    .map((message) => message.body)
}

class ScriptedConversationRuntime implements RuntimeAdapter {
  readonly requests: RuntimeTaskRequest[] = []
  readonly calls: Array<RuntimeTaskRequest['conversation']> = []
  readonly resumes: RuntimeSession[] = []
  readonly inputs: Array<{ session: RuntimeSession; input: string }> = []
  failNextResume = false
  readonly availability: RuntimeAvailability = { executable: 'available', taskExecution: 'unverified' }
  private readonly namesByAgentId = new Map<string, string>()
  private readonly resumedTaskIds = new Set<string>()

  constructor(private readonly options: { failingMention?: string } = {}) {}

  async detect(): Promise<RuntimeAvailability> {
    return this.availability
  }

  register(agentId: string, mentionName: string): void {
    this.namesByAgentId.set(agentId, mentionName)
  }

  async start(request: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.requests.push(request)
    this.calls.push(request.conversation)
    this.emit(request, sink)
    return sessionFor(request)
  }

  sendInput(session: RuntimeSession, input: string, sink: RuntimeEventSink): void {
    this.inputs.push({ session, input })
    const request = this.requests.find((candidate) => candidate.taskId === session.taskId)
      ?? this.requests.find((candidate) => candidate.worktreePath === session.worktreePath)
    if (!request) {
      sink({ kind: 'text', taskId: session.taskId, text: JSON.stringify({ reply: 'Recovered public answer', handoffTo: [] }) })
      sink({ kind: 'settled', taskId: session.taskId })
      return
    }
    const conversation = request.conversation
    if (!conversation) throw new Error('Expected a conversation Runtime request.')
    const kind: 'duplicate_check' | 'response' = input.startsWith('Check whether') ? 'duplicate_check' : 'response'
    const call = { ...request, taskId: session.taskId, conversation: { ...conversation, kind } }
    this.calls.push(call.conversation)
    this.emit(call, sink, this.resumedTaskIds.has(session.taskId))
  }

  async resume(session: RuntimeSession, _sink: RuntimeEventSink): Promise<void> {
    this.resumes.push(session)
    if (this.failNextResume) {
      this.failNextResume = false
      throw new Error('resume failed')
    }
    this.resumedTaskIds.add(session.taskId)
  }

  cancel(_session: RuntimeSession): void {}

  private emit(request: RuntimeTaskRequest, sink: RuntimeEventSink, resumed = false): void {
    const agentId = request.worktreePath.split(path.sep).at(-1)!
    const mention = this.namesByAgentId.get(agentId) ?? agentId
    if (this.options.failingMention === mention && request.conversation?.kind === 'response') {
      sink({ kind: 'artifact', taskId: request.taskId, artifactType: 'runtime-stdout', content: 'RAW_RUNTIME_ARTIFACT' })
      sink({ kind: 'error', taskId: request.taskId, message: 'isolated runtime failure' })
      return
    }
    const text = request.conversation?.kind === 'participation'
      ? JSON.stringify({ decision: 'speak', confidence: 1, reason: 'incident match', proposedAngle: mention, dependsOnAgentId: null })
      : request.conversation?.kind === 'duplicate_check'
        ? JSON.stringify({ decision: 'speak', reason: 'independent detail', revisedAngle: null })
        : JSON.stringify({
            reply: resumed
              ? `${title(mention)} resumed answer`
              : `${title(mention)} ${request.conversation?.kind === 'handoff_response'
                ? 'handoff answer'
                : mention === 'beta' ? 'independent answer' : 'public answer'}`,
            handoffTo: mention === 'alpha' && request.conversation?.kind === 'response'
              ? [{ agentId: this.agentIdFor('gamma'), question: 'Please provide the next check.' }]
              : [],
          })
    sink({ kind: 'artifact', taskId: request.taskId, artifactType: 'runtime-stdout', content: 'RAW_RUNTIME_ARTIFACT' })
    sink({ kind: 'text', taskId: request.taskId, text })
    sink({ kind: 'settled', taskId: request.taskId })
  }

  private agentIdFor(mentionName: string): string {
    const agent = [...this.namesByAgentId.entries()].find(([, name]) => name === mentionName)
    if (!agent) throw new Error(`Missing ${mentionName} Agent.`)
    return agent[0]
  }
}

function sessionFor(request: RuntimeTaskRequest): RuntimeSession {
  return {
    taskId: request.taskId,
    runtime: request.profile.runtime,
    worktreePath: request.worktreePath,
    profile: request.profile,
    sessionId: `session-${request.taskId}`,
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}

function title(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
