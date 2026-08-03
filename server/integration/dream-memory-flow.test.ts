import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../app'
import type { RuntimeAvailability } from '../adapters/runtime/runtime-profile'
import { DreamRunService } from '../application/dream-run-service'
import { MemoryConsolidator } from '../application/memory-consolidator'
import { MemoryReviewService } from '../application/memory-review-service'
import type { MemoryCandidate } from '../domain/memory'
import type { Message } from '../domain/message'
import type { WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../ports/runtime'
import { startHttpTestServer } from '../test/http-test-server'

describe('Dream Memory lifecycle', () => {
  let dataDirectory: string | undefined
  const closeApplications: Array<() => void> = []
  const dreamServices: DreamRunService[] = []

  afterEach(async () => {
    for (const service of dreamServices.splice(0)) await service.shutdown()
    for (const close of closeApplications.splice(0).reverse()) close()
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
    dataDirectory = undefined
  })

  it('keeps extraction reviewable, scopes cold prompts, persists state, and safely replays watermarks', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-dream-flow-'))
    const databasePath = path.join(dataDirectory, 'sinapsis.sqlite')
    const conversationRuntime = new PromptRecordingRuntime()
    const first = createApp({ databasePath, conversationRuntimes: { opencode: conversationRuntime } })
    closeApplications.push(closeApp(first))
    const repositories = first.locals.repositories as WorkspaceRepositories
    const { alphaId, betaId } = seedChannels(repositories, dataDirectory)
    const alphaSource = repositories.createMessage({
      channelId: alphaId,
      senderType: 'human',
      authorName: 'You',
      body: 'We confirmed our release-note and deployment conventions.',
    })
    repositories.createMessage({
      channelId: betaId,
      senderType: 'human',
      authorName: 'You',
      body: 'A private credential appeared here and must never become Memory.',
    })

    const dreamRuntime = new ScriptedDreamRuntime()
    const dreamService = createDreamService(repositories, dreamRuntime, dataDirectory)
    dreamServices.push(dreamService)
    const alphaRun = dreamService.enqueue({ channelId: alphaId, trigger: 'manual' })
    const completedAlphaRun = await dreamService.waitFor(alphaRun.id)

    expect(completedAlphaRun).toMatchObject({ status: 'completed', candidateCount: 3 })
    expect(dreamRuntime.requests).toHaveLength(1)
    expect(dreamRuntime.requests[0]?.description).toContain(alphaSource.id)
    expect(dreamRuntime.requests[0]?.description).not.toContain(betaId)
    expect(repositories.listDreamRuns({ channelId: betaId })).toEqual([])

    const candidates = repositories.listMemoryCandidates({ dreamRunId: alphaRun.id })
    expect(candidates).toHaveLength(3)
    const duplicate = dreamService.enqueue({ channelId: alphaId, trigger: 'manual' })
    expect(duplicate.id).toBe(alphaRun.id)
    await expect(dreamService.waitFor(duplicate.id)).resolves.toMatchObject({ status: 'completed' })
    expect(dreamRuntime.requests).toHaveLength(1)
    expect(repositories.listMemoryCandidates({ dreamRunId: alphaRun.id })).toHaveLength(3)

    const pendingGlobal = candidateWithContent(candidates, 'Team uses Chinese for release notes.')
    const pendingChannel = candidateWithContent(candidates, 'Alpha deploys after review approval.')
    const pendingAfterRestart = candidateWithContent(candidates, 'Keep architecture decisions explicit.')
    const beforeReviewAlpha = await invokeColdPrompt(first, repositories, conversationRuntime, alphaId, 'before-alpha')
    const beforeReviewBeta = await invokeColdPrompt(first, repositories, conversationRuntime, betaId, 'before-beta')
    for (const prompt of [beforeReviewAlpha, beforeReviewBeta]) {
      expect(prompt).not.toContain(pendingGlobal.proposedContent)
      expect(prompt).not.toContain(pendingChannel.proposedContent)
      expect(prompt).not.toContain(pendingAfterRestart.proposedContent)
    }

    const review = new MemoryReviewService({ repositories })
    const globalMemory = review.accept(pendingGlobal.id, {
      scope: 'global',
      content: pendingGlobal.proposedContent,
    })
    const globalAlpha = await invokeColdPrompt(first, repositories, conversationRuntime, alphaId, 'global-alpha')
    const globalBeta = await invokeColdPrompt(first, repositories, conversationRuntime, betaId, 'global-beta')
    expect(globalAlpha).toContain(pendingGlobal.proposedContent)
    expect(globalBeta).toContain(pendingGlobal.proposedContent)

    const channelMemory = review.accept(pendingChannel.id, {
      scope: 'channel',
      channelId: alphaId,
      content: pendingChannel.proposedContent,
    })
    const channelAlpha = await invokeColdPrompt(first, repositories, conversationRuntime, alphaId, 'channel-alpha')
    const channelBeta = await invokeColdPrompt(first, repositories, conversationRuntime, betaId, 'channel-beta')
    expect(channelAlpha).toContain(pendingChannel.proposedContent)
    expect(channelBeta).not.toContain(pendingChannel.proposedContent)

    const editedContent = 'Team uses bilingual release notes.'
    review.update(globalMemory.id, { content: editedContent })
    const editedPrompt = await invokeColdPrompt(first, repositories, conversationRuntime, alphaId, 'edited-alpha')
    expect(editedPrompt).toContain(editedContent)
    expect(editedPrompt).not.toContain(pendingGlobal.proposedContent)
    review.archive(globalMemory.id)
    const archivedPrompt = await invokeColdPrompt(first, repositories, conversationRuntime, alphaId, 'archived-alpha')
    expect(archivedPrompt).not.toContain(editedContent)

    const threadRoot = repositories.createMessage({
      channelId: alphaId,
      senderType: 'human',
      authorName: 'You',
      body: 'Thread root retained across restart',
    })
    const threadReply = repositories.createMessage({
      channelId: alphaId,
      threadRootMessageId: threadRoot.id,
      senderType: 'human',
      authorName: 'You',
      body: 'Thread reply retained across restart',
    })
    const summary = repositories.upsertThreadSummary({
      channelId: alphaId,
      threadRootMessageId: threadRoot.id,
      content: 'Persisted Thread Summary',
      throughMessageCreatedAt: threadReply.createdAt,
      throughMessageId: threadReply.id,
    })
    const alphaWatermark = repositories.getDreamWatermark(alphaId)
    expect(alphaWatermark?.toMessageId).toBe(alphaSource.id)

    closeApplications.pop()?.()
    const rebuilt = createApp({ databasePath, conversationRuntimes: { opencode: conversationRuntime } })
    closeApplications.push(closeApp(rebuilt))
    const rebuiltRepositories = rebuilt.locals.repositories as WorkspaceRepositories
    expect(rebuiltRepositories.getDreamWatermark(alphaId)).toEqual(alphaWatermark)
    expect(rebuiltRepositories.getMemoryCandidate(pendingAfterRestart.id)).toMatchObject({ status: 'pending' })
    expect(rebuiltRepositories.getMemory(channelMemory.id)).toMatchObject({ status: 'active' })
    expect(rebuiltRepositories.getMemory(globalMemory.id)).toMatchObject({ status: 'archived' })
    expect(rebuiltRepositories.getThreadSummary(alphaId, threadRoot.id)).toEqual(summary)

    const unsafeRuntime = new ScriptedDreamRuntime({ unsafeChannelId: betaId })
    const unsafeService = createDreamService(rebuiltRepositories, unsafeRuntime, dataDirectory)
    dreamServices.push(unsafeService)
    const unsafeRun = unsafeService.enqueue({ channelId: betaId, trigger: 'manual' })
    await expect(unsafeService.waitFor(unsafeRun.id)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Unsafe memory content: secret material'),
    })
    expect(rebuiltRepositories.listMemoryCandidates({ dreamRunId: unsafeRun.id })).toEqual([])
    const persistedCandidateText = JSON.stringify(rebuiltRepositories.listMemoryCandidates())
    expect(persistedCandidateText).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456')
    expect(persistedCandidateText).not.toContain('RUNTIME_ARTIFACT_SECRET')

    const interruptedSourcesBefore = rebuiltRepositories.listDreamRuns({ channelId: alphaId }).length
    const interrupted = rebuiltRepositories.createIncrementalDreamRun({ channelId: alphaId, trigger: 'scheduled' })
    rebuiltRepositories.updateDreamRun(interrupted.id, {
      status: 'running',
      startedAt: '2026-08-03T02:00:00.000Z',
    })
    const sourceIds = rebuiltRepositories.listDreamSourceMessages(interrupted.id).map((message) => message.id)
    expect(sourceIds.length).toBeGreaterThan(0)
    const retainedReplayCandidate = rebuiltRepositories.createMemoryCandidate({
      dreamRunId: interrupted.id,
      proposedScope: 'global',
      channelId: null,
      kind: 'fact',
      proposedContent: 'Team uses Chinese for release notes.',
      rationale: 'The user confirmed this durable convention.',
      confidence: 0.9,
      importance: 0.8,
      sourceMessageIds: [sourceIds[0]!],
    })
    const retainedSources = rebuiltRepositories.listMemoryCandidateSourceMetadata(retainedReplayCandidate.id)
    rebuiltRepositories.recoverDreamMemory(new Date('2026-08-03T02:01:00.000Z'))
    expect(rebuiltRepositories.getDreamRun(interrupted.id)).toMatchObject({
      status: 'failed',
      error: 'service_restarted',
      completedAt: '2026-08-03T02:01:00.000Z',
    })
    expect(rebuiltRepositories.getDreamWatermark(alphaId)).toEqual(alphaWatermark)

    const replayRuntime = new ScriptedDreamRuntime()
    const replayService = createDreamService(rebuiltRepositories, replayRuntime, dataDirectory)
    dreamServices.push(replayService)
    const replayed = replayService.enqueue({ channelId: alphaId, trigger: 'scheduled' })
    expect(replayed.id).toBe(interrupted.id)
    await expect(replayService.waitFor(replayed.id)).resolves.toMatchObject({ status: 'completed' })
    expect(replayRuntime.requests).toHaveLength(1)
    expect(rebuiltRepositories.listDreamSourceMessages(replayed.id).map((message) => message.id)).toEqual(sourceIds)
    expect(rebuiltRepositories.getMemoryCandidate(retainedReplayCandidate.id)).toEqual(retainedReplayCandidate)
    expect(rebuiltRepositories.listMemoryCandidateSourceMetadata(retainedReplayCandidate.id)).toEqual(retainedSources)
    expect(rebuiltRepositories.listMemoryCandidates({ dreamRunId: replayed.id })).toHaveLength(2)
    expect(rebuiltRepositories.getDreamWatermark(alphaId)?.toMessageId).toBe(sourceIds.at(-1))
    expect(rebuiltRepositories.listDreamRuns({ channelId: alphaId })).toHaveLength(interruptedSourcesBefore + 1)
  })

  it('runs Dream and reviews its Memory through the fully assembled HTTP API', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-dream-http-flow-'))
    const databasePath = path.join(dataDirectory, 'sinapsis.sqlite')
    const dreamRuntime = new ScriptedDreamRuntime()
    const app = createApp({ databasePath, dreamRuntime })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { alphaId } = seedChannels(repositories, dataDirectory)
    const publicAgent = repositories.createAgent({
      identity: 'Dream Public Agent',
      mentionName: 'dream-public-agent',
      runtime: 'opencode',
      capabilityTags: [],
      responsibilities: [],
      maxConcurrentTasks: 1,
      command: 'fake-conversation-runtime',
      args: [],
      model: '',
      env: {},
    })
    const source = repositories.createMessage({
      channelId: alphaId,
      senderType: 'human',
      authorName: 'You',
      body: 'The team confirmed durable release practices.',
    })
    const turn = repositories.createConversationTurn({
      channelId: alphaId,
      triggerMessageId: source.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    const invocation = repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: publicAgent.id,
      kind: 'response',
      priority: 'human_direct',
      round: 1,
      idempotencyKey: `${turn.id}:response`,
      sourceInvocationId: null,
      status: 'running',
    })
    const publicReply = 'The published Turn confirms Chinese release notes.'
    repositories.settleConversationInvocation({
      invocationId: invocation.id,
      recoveryOwnerId: null,
      resultJson: JSON.stringify({
        text: 'PRIVATE_RAW_RUNTIME_TEXT',
        parsed: { reply: publicReply, handoffTo: [], hiddenDeliberation: 'PRIVATE_DELIBERATION' },
        runtimeStderr: 'PRIVATE_STDERR',
        artifacts: ['PRIVATE_ARTIFACT'],
      }),
      publicReply: { authorName: publicAgent.identity, body: publicReply },
      occurredAt: new Date('2026-08-03T00:00:01.000Z'),
    })
    repositories.updateConversationTurn(turn.id, {
      status: 'completed',
      completedAt: '2026-08-03T00:00:01.000Z',
    })
    const server = await startHttpTestServer(app)

    try {
      const manual = await fetch(`${server.baseUrl}/api/dream/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: alphaId }),
      })
      expect(manual.status).toBe(202)
      const queued = await manual.json() as Array<{ id: string; scopeId: string }>
      expect(queued).toEqual([expect.objectContaining({ scopeId: alphaId })])
      await expect(waitForDreamRun(server.baseUrl, queued[0]!.id)).resolves.toMatchObject({
        status: 'completed', candidateCount: 3,
      })
      expect(dreamRuntime.requests).toHaveLength(1)
      const consolidationPrompt = JSON.parse(dreamRuntime.requests[0]!.description) as {
        turnPublicResults: Array<{ turnId: string; invocationId: string; reply: string }>
      }
      expect(consolidationPrompt.turnPublicResults).toEqual([
        { turnId: turn.id, invocationId: invocation.id, reply: publicReply },
      ])
      for (const privateValue of [
        'PRIVATE_RAW_RUNTIME_TEXT', 'PRIVATE_DELIBERATION', 'PRIVATE_STDERR', 'PRIVATE_ARTIFACT',
      ]) expect(dreamRuntime.requests[0]!.description).not.toContain(privateValue)

      const pendingResponse = await fetch(`${server.baseUrl}/api/memory-candidates?status=pending`)
      expect(pendingResponse.status).toBe(200)
      const pending = await pendingResponse.json() as Array<{ id: string; proposedContent: string }>
      const candidate = pending.find((item) => item.proposedContent === 'Team uses Chinese for release notes.')
      expect(candidate).toBeDefined()

      const acceptedResponse = await fetch(`${server.baseUrl}/api/memory-candidates/${candidate!.id}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', content: candidate!.proposedContent }),
      })
      expect(acceptedResponse.status).toBe(200)
      const accepted = await acceptedResponse.json() as { id: string; status: string; sourceCandidateId: string }
      expect(accepted).toMatchObject({ status: 'active', sourceCandidateId: candidate!.id })

      const editedResponse = await fetch(`${server.baseUrl}/api/memories/${accepted.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Team uses bilingual release notes.' }),
      })
      expect(editedResponse.status).toBe(200)
      await expect(editedResponse.json()).resolves.toMatchObject({
        id: accepted.id, content: 'Team uses bilingual release notes.', status: 'active',
      })

      const archivedResponse = await fetch(`${server.baseUrl}/api/memories/${accepted.id}`, { method: 'DELETE' })
      expect(archivedResponse.status).toBe(200)
      await expect(archivedResponse.json()).resolves.toMatchObject({
        id: accepted.id, status: 'archived', archivedAt: expect.any(String),
      })
      const memories = await fetch(`${server.baseUrl}/api/memories`).then((response) => response.json()) as unknown[]
      expect(memories).toEqual([])
    } finally {
      await server.close()
      closeApp(app)()
    }
  })
})

function seedChannels(repositories: WorkspaceRepositories, repositoryPath: string): { alphaId: string; betaId: string } {
  const workspace = repositories.createWorkspace({ name: 'Dream integration' })
  repositories.createRepository({
    workspaceId: workspace.id,
    name: 'dream-integration',
    path: repositoryPath,
    currentBranch: 'main',
    defaultBranch: 'main',
    isClean: true,
  })
  return {
    alphaId: repositories.createChannel({ name: 'dream-alpha' }).id,
    betaId: repositories.createChannel({ name: 'dream-beta' }).id,
  }
}

function createDreamService(
  repositories: WorkspaceRepositories,
  runtime: RuntimeAdapter,
  dataDir: string,
): DreamRunService {
  return new DreamRunService({
    repositories,
    consolidator: new MemoryConsolidator({
      repositories,
      runtime,
      dataDir,
      profile: {
        runtime: 'opencode',
        command: 'fake-dream-runtime',
        args: [],
        model: '',
        env: {},
        policy: 'task-worktree',
      },
      timeoutMs: 1_000,
      maxCandidates: 10,
    }),
    concurrency: 1,
  })
}

async function invokeColdPrompt(
  app: ReturnType<typeof createApp>,
  repositories: WorkspaceRepositories,
  runtime: PromptRecordingRuntime,
  channelId: string,
  mentionName: string,
): Promise<string> {
  const agent = repositories.createAgent({
    identity: mentionName,
    mentionName,
    runtime: 'opencode',
    capabilityTags: [],
    responsibilities: [],
    maxConcurrentTasks: 1,
    command: 'fake-conversation-runtime',
    args: [],
    model: '',
    env: {},
  })
  repositories.setAgentStatus(agent.id, 'idle', new Date())
  repositories.addChannelAgent(channelId, agent.id, new Date())
  const message = repositories.createMessage({
    channelId,
    senderType: 'human',
    authorName: 'You',
    body: `@${mentionName} verify cold context`,
  })
  const requestsBefore = runtime.requests.length
  await (app.locals.conversationCoordinator as { dispatch(channelId: string, message: Message): Promise<unknown> })
    .dispatch(channelId, message)
  const request = runtime.requests.slice(requestsBefore)
    .find((candidate) => candidate.conversation?.kind === 'response')
  expect(request, `missing response prompt for @${mentionName}`).toBeDefined()
  return request!.description
}

function candidateWithContent(candidates: MemoryCandidate[], content: string): MemoryCandidate {
  const candidate = candidates.find((item) => item.proposedContent === content)
  if (!candidate) throw new Error(`Missing candidate: ${content}`)
  return candidate
}

async function waitForDreamRun(baseUrl: string, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000
  while (true) {
    const response = await fetch(`${baseUrl}/api/dream/runs/${runId}`)
    expect(response.status).toBe(200)
    const run = await response.json() as Record<string, unknown>
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Dream run ${runId}.`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function closeApp(app: ReturnType<typeof createApp>): () => void {
  let closed = false
  return () => {
    if (closed) return
    closed = true
    ;(app.locals.closeSse as (() => void) | undefined)?.()
    ;(app.locals.closeDatabase as (() => void) | undefined)?.()
  }
}

class ScriptedDreamRuntime implements RuntimeAdapter {
  readonly requests: RuntimeTaskRequest[] = []
  readonly availability: RuntimeAvailability = { executable: 'available', taskExecution: 'unverified' }

  constructor(private readonly options: { unsafeChannelId?: string } = {}) {}

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve(this.availability)
  }

  async start(request: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.requests.push(request)
    const prompt = JSON.parse(request.description) as {
      channel: { id: string }
      messages: Array<{ id: string }>
    }
    const sourceMessageId = prompt.messages[0]?.id
    if (!sourceMessageId) throw new Error('Expected at least one Dream source message.')
    const candidates = prompt.channel.id === this.options.unsafeChannelId
      ? [proposal(sourceMessageId, 'global', 'The API key is sk-proj-abcdefghijklmnopqrstuvwxyz123456.')]
      : [
          proposal(sourceMessageId, 'global', 'Team uses Chinese for release notes.'),
          proposal(sourceMessageId, 'channel', 'Alpha deploys after review approval.'),
          proposal(sourceMessageId, 'global', 'Keep architecture decisions explicit.'),
        ]
    sink({
      kind: 'artifact',
      taskId: request.taskId,
      artifactType: 'runtime-stdout',
      content: 'RUNTIME_ARTIFACT_SECRET',
    })
    sink({ kind: 'text', taskId: request.taskId, text: JSON.stringify({ candidates }) })
    sink({ kind: 'settled', taskId: request.taskId })
    return runtimeSession(request)
  }

  sendInput(): void {}
  resume(): Promise<void> { return Promise.resolve() }
  cancel(): void {}
}

class PromptRecordingRuntime implements RuntimeAdapter {
  readonly requests: RuntimeTaskRequest[] = []
  readonly availability: RuntimeAvailability = { executable: 'available', taskExecution: 'unverified' }

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve(this.availability)
  }

  async start(request: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.requests.push(request)
    sink({
      kind: 'text',
      taskId: request.taskId,
      text: JSON.stringify({ reply: 'Context observed.', handoffTo: [] }),
    })
    sink({ kind: 'settled', taskId: request.taskId })
    return runtimeSession(request)
  }

  sendInput(session: RuntimeSession, _input: string, sink: RuntimeEventSink): void {
    sink({
      kind: 'text',
      taskId: session.taskId,
      text: JSON.stringify({ reply: 'Context observed.', handoffTo: [] }),
    })
    sink({ kind: 'settled', taskId: session.taskId })
  }

  resume(): Promise<void> {
    return Promise.reject(new Error('Force cold start for prompt inspection.'))
  }

  cancel(): void {}
}

function proposal(sourceMessageId: string, scope: 'global' | 'channel', content: string) {
  return {
    scope,
    kind: 'fact',
    content,
    rationale: 'The user confirmed this durable convention.',
    confidence: 0.9,
    importance: 0.8,
    sourceMessageIds: [sourceMessageId],
  }
}

function runtimeSession(request: RuntimeTaskRequest): RuntimeSession {
  return {
    taskId: request.taskId,
    runtime: request.profile.runtime,
    worktreePath: request.worktreePath,
    profile: request.profile,
    executionPolicy: request.executionPolicy,
    sessionId: `session-${request.taskId}`,
    sessionFile: null,
    isStreaming: false,
    queueLength: 0,
    pendingInputs: [],
  }
}
