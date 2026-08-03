import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app'
import { startHttpTestServer } from './test/http-test-server'
import type { WorkspaceRepositories } from './ports/repositories'
import { ConversationCoordinator } from './application/conversation-coordinator'
import type { ChannelTurnCoordinator } from './application/channel-turn-coordinator'
import type { ConversationTurn } from './domain/conversation'
import type { DomainEvent } from './domain/events'
import type { TaskExecutionCoordinator } from './application/task-execution-coordinator'

describe('local service API', () => {
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    closeServer = undefined
  })

  it('returns an OK health response', async () => {
    const server = await startHttpTestServer(createApp())
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/health`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('requires a server-issued human capability for Memory review routes', async () => {
    const humanCapability = 'test-human-capability-that-agents-do-not-receive'
    const app = createApp({ humanCapability })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Human review gate' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/human-review-gate' })
    const channel = repositories.createChannel({ name: 'human-review-gate' })
    const source = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'You',
      body: 'This candidate requires a human decision.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const candidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: channel.id, kind: 'fact',
      proposedContent: 'Humans approve durable memory.', rationale: 'Explicit review policy.', confidence: 0.9, importance: 0.9,
      sourceMessageIds: [source.id],
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    expect((await fetch(`${server.baseUrl}/api/dream/runs`)).status).toBe(403)
    expect((await fetch(`${server.baseUrl}/api/memory-candidates?status=pending`)).status).toBe(403)
    expect((await fetch(`${server.baseUrl}/api/memory-candidates?status=pending`, {
      headers: { 'x-sinapsis-human-capability': 'wrong-capability' },
    })).status).toBe(403)
    const forgedAccept = await fetch(`${server.baseUrl}/api/memory-candidates/${candidate.id}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', content: candidate.proposedContent }),
    })
    expect(forgedAccept.status).toBe(403)
    expect(repositories.getMemoryCandidate(candidate.id)?.status).toBe('pending')

    const authorized = await fetch(`${server.baseUrl}/api/memory-candidates?status=pending`, {
      headers: { 'x-sinapsis-human-capability': humanCapability },
    })
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toEqual([
      expect.objectContaining({ id: candidate.id, status: 'pending' }),
    ])
  })

  it('composes Dream maintenance without starting its daily scheduler in the test app', () => {
    const app = createApp()
    try {
      expect(app.locals.dreamRunService).toMatchObject({ enqueue: expect.any(Function), waitFor: expect.any(Function) })
      expect(app.locals.dreamScheduler).toBeUndefined()
    } finally {
      app.locals.closeDatabase()
    }
  })

  it('reviews Candidates through strict Memory APIs without exposing Dream runtime internals', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Dream Memory' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const sourceChannel = repositories.createChannel({ name: 'source' })
    const targetChannel = repositories.createChannel({ name: 'target' })
    const source = repositories.createMessage({
      channelId: sourceChannel.id, senderType: 'human', authorName: 'Jodu', body: 'React is the frontend standard.',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: sourceChannel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const candidate = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: sourceChannel.id, kind: 'fact',
      proposedContent: 'React is the frontend standard.', rationale: 'Repeated decision.', confidence: 0.9, importance: 0.8,
      sourceMessageIds: [source.id],
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const rejectUnsafe = await fetch(`${server.baseUrl}/api/memory-candidates/${candidate.id}/accept`, {
      method: 'POST', headers: humanHeaders(app, true),
      body: JSON.stringify({ scope: 'global', content: 'API_KEY=super-secret-value', prompt: 'do not accept this' }),
    })
    expect(rejectUnsafe.status).toBe(400)

    const rejectOverLimitBeforeTrimming = await fetch(`${server.baseUrl}/api/memory-candidates/${candidate.id}/accept`, {
      method: 'POST', headers: humanHeaders(app, true),
      body: JSON.stringify({ scope: 'channel', channelId: targetChannel.id, content: `A${' '.repeat(10_000)}` }),
    })
    expect(rejectOverLimitBeforeTrimming.status).toBe(400)

    const accepted = await fetch(`${server.baseUrl}/api/memory-candidates/${candidate.id}/accept`, {
      method: 'POST', headers: humanHeaders(app, true),
      body: JSON.stringify({ scope: 'channel', channelId: targetChannel.id, content: 'React is the frontend standard.' }),
    })
    expect(accepted.status).toBe(200)
    const memory = await accepted.json() as { id: string; channelId: string; sourceCandidateId: string }
    expect(memory).toMatchObject({ channelId: targetChannel.id, sourceCandidateId: candidate.id })
    expect(repositories.getMemoryCandidate(candidate.id)).toMatchObject({
      channelId: sourceChannel.id, reviewedScope: 'channel', reviewedChannelId: targetChannel.id,
    })

    const repeated = await fetch(`${server.baseUrl}/api/memory-candidates/${candidate.id}/accept`, {
      method: 'POST', headers: humanHeaders(app, true),
      body: JSON.stringify({ scope: 'global', content: 'A later request cannot change accepted Memory.' }),
    })
    await expect(repeated.json()).resolves.toMatchObject({ id: memory.id, channelId: targetChannel.id })

    const runs = await fetch(`${server.baseUrl}/api/dream/runs`, { headers: humanHeaders(app) })
    const runsJson = await runs.json() as unknown
    expect(JSON.stringify(runsJson)).not.toMatch(/runtime.*(?:log|prompt)|artifact/i)

    const changed = await fetch(`${server.baseUrl}/api/memories/${memory.id}`, {
      method: 'PATCH', headers: humanHeaders(app, true), body: JSON.stringify({ content: 'Frontend standard: React.' }),
    })
    expect(changed.status).toBe(200)
    const archived = await fetch(`${server.baseUrl}/api/memories/${memory.id}`, { method: 'DELETE', headers: humanHeaders(app) })
    await expect(archived.json()).resolves.toMatchObject({ status: 'archived', sourceCandidateId: candidate.id, archivedAt: expect.any(String) })
  })

  it('filters Candidate reviews by a strict status and projects only public source metadata', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Dream Memory' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const sourceChannel = repositories.createChannel({ name: 'source' })
    const source = repositories.createMessage({
      channelId: sourceChannel.id, senderType: 'human', authorName: 'Jodu', body: '公开讨论内容。',
    })
    const run = repositories.createDreamRun({
      scope: 'channel', scopeId: sourceChannel.id, trigger: 'manual', from: null,
      to: { createdAt: source.createdAt, id: source.id },
    })
    const pending = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: sourceChannel.id, kind: 'fact',
      proposedContent: '公开事实。', rationale: '来源明确。', confidence: 0.9, importance: 0.8, sourceMessageIds: [source.id],
    })
    const ignored = repositories.createMemoryCandidate({
      dreamRunId: run.id, proposedScope: 'channel', channelId: sourceChannel.id, kind: 'workflow',
      proposedContent: '被忽略的流程。', rationale: '不再需要。', confidence: 0.6, importance: 0.4, sourceMessageIds: [source.id],
    })
    repositories.reviewMemoryCandidate({ candidateId: ignored.id, status: 'ignored', occurredAt: new Date('2026-08-01T00:00:00.000Z') })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const filtered = await fetch(`${server.baseUrl}/api/memory-candidates?status=pending`, { headers: humanHeaders(app) })
    expect(filtered.status).toBe(200)
    const candidates = await filtered.json() as Array<Record<string, unknown>>
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: pending.id,
      sourceMessageCount: 1,
      sources: [{ channelId: sourceChannel.id, channelName: 'source', messageId: source.id, threadRootMessageId: null }],
    })
    expect(JSON.stringify(candidates)).not.toMatch(/runtime|prompt|log|artifact|公开讨论内容/i)

    const invalid = await fetch(`${server.baseUrl}/api/memory-candidates?status=unknown`, { headers: humanHeaders(app) })
    expect(invalid.status).toBe(400)

    const bootstrap = await fetch(`${server.baseUrl}/api/bootstrap`)
    await expect(bootstrap.json()).resolves.toMatchObject({ pendingMemoryCandidateCount: 1 })
  })

  it('returns an old public source message with its Thread root only in the matching channel', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Dream Memory' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'source' })
    const other = repositories.createChannel({ name: 'other' })
    const root = repositories.createMessage({ channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: '很早的公开根消息。' })
    const reply = repositories.createMessage({ channelId: channel.id, threadRootMessageId: root.id, senderType: 'agent', authorName: 'Agent', body: '很早的公开回复。' })
    for (let index = 0; index < 51; index += 1) repositories.createMessage({ channelId: channel.id, senderType: 'human', authorName: 'Jodu', body: `较新的消息 ${index}` })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages/${reply.id}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ message: expect.objectContaining({ id: reply.id, body: reply.body, threadRootMessageId: root.id }), threadRoot: expect.objectContaining({ id: root.id, body: root.body }) })
    const foreign = await fetch(`${server.baseUrl}/api/channels/${other.id}/messages/${reply.id}`)
    expect(foreign.status).toBe(404)
    repositories.deleteMessage(root.id)
    const deletedRoot = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages/${reply.id}`)
    expect(deletedRoot.status).toBe(404)
  })

  it('queues persisted Dream runs and rejects fields outside the manual-run contract', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Dream Memory' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'dreams' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const invalid = await fetch(`${server.baseUrl}/api/dream/runs`, {
      method: 'POST', headers: humanHeaders(app, true), body: JSON.stringify({ channelId: channel.id, runtimeLog: 'private' }),
    })
    expect(invalid.status).toBe(400)

    const queued = await fetch(`${server.baseUrl}/api/dream/runs`, {
      method: 'POST', headers: humanHeaders(app, true), body: JSON.stringify({ channelId: channel.id }),
    })
    expect(queued.status).toBe(202)
    await expect(queued.json()).resolves.toEqual([expect.objectContaining({ scopeId: channel.id, status: expect.stringMatching(/queued|running|completed/) })])
  })

  it('projects Dream failures as deterministic categories without raw runtime errors', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Dream Memory' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'dreams' })
    const run = repositories.createDreamRun({ scope: 'channel', scopeId: channel.id, trigger: 'manual', from: null, to: null })
    repositories.updateDreamRun(run.id, { status: 'failed', error: 'RAW_RUNTIME_PROMPT=never expose this', completedAt: '2026-08-02T00:00:00.000Z' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/dream/runs`, { headers: humanHeaders(app) })
    expect(response.status).toBe(200)
    const runs = await response.json() as Array<Record<string, unknown>>
    expect(runs).toEqual([expect.objectContaining({ id: run.id, status: 'failed', errorCategory: 'runtime_failure' })])
    expect(runs[0]).not.toHaveProperty('error')
    expect(JSON.stringify(runs)).not.toContain('RAW_RUNTIME_PROMPT')
  })

  it('returns stable not-found and strict-body errors for Dream and Memory mutations', async () => {
    const app = createApp()
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const unknownDreamChannel = await fetch(`${server.baseUrl}/api/dream/runs`, {
      method: 'POST', headers: humanHeaders(app, true), body: JSON.stringify({ channelId: 'missing-channel' }),
    })
    expect(unknownDreamChannel.status).toBe(404)

    const missingMemoryPatch = await fetch(`${server.baseUrl}/api/memories/missing-memory`, {
      method: 'PATCH', headers: humanHeaders(app, true), body: JSON.stringify({ content: 'Updated.' }),
    })
    expect(missingMemoryPatch.status).toBe(404)

    const invalidDelete = await fetch(`${server.baseUrl}/api/memories/missing-memory`, {
      method: 'DELETE', headers: humanHeaders(app, true), body: JSON.stringify({ force: true }),
    })
    expect(invalidDelete.status).toBe(400)

    const missingMemoryDelete = await fetch(`${server.baseUrl}/api/memories/missing-memory`, { method: 'DELETE', headers: humanHeaders(app) })
    expect(missingMemoryDelete.status).toBe(404)
  })

  it('creates a workspace from a validated JSON request', async () => {
    const server = await startHttpTestServer(createApp())
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sinapsis' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ name: 'Sinapsis' })
  })

  it('rejects a malformed workspace creation request', async () => {
    const server = await startHttpTestServer(createApp())
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })

    expect(response.status).toBe(400)
  })

  it('creates a global Agent without returning a Workspace locator or environment variable values', async () => {
    const server = await startHttpTestServer(createApp({
      runtimeAvailabilityDetector: {
        detect: async () => ({ executable: 'available', taskExecution: 'unverified' }),
      },
    }))
    closeServer = server.close

    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sinapsis' }),
    })
    const workspace = await workspaceResponse.json() as { id: string }

    const agentResponse = await fetch(`${server.baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity: 'Build engineer', mention: 'build', runtime: 'opencode', capabilityTags: ['typescript'],
        env: { API_TOKEN: 'do-not-return-this' },
      }),
    })

    expect(agentResponse.status).toBe(201)
    const agent = await agentResponse.json() as Record<string, unknown>
    expect(agent).toMatchObject({ profile: { env: ['API_TOKEN'] } })
    expect(agent).not.toHaveProperty('workspaceId')

    const bootstrapResponse = await fetch(`${server.baseUrl}/api/bootstrap`)
    const bootstrap = await bootstrapResponse.json() as { agents: Array<{ env: unknown }>; workspaces: Array<Record<string, unknown>> }
    expect(bootstrap.agents[0].env).toEqual(['API_TOKEN'])
    expect(bootstrap.workspaces[0]).not.toHaveProperty('agents')
  })

  it('publishes the configured workspace binding limit in the bootstrap snapshot', async () => {
    const server = await startHttpTestServer(createApp({ maxWorkspaceBindingsPerChannel: 3 }))
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/bootstrap`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      maxWorkspaceBindingsPerChannel: 3,
    })
  })

  it('keeps the workspace-scoped Agent route as a locator-free compatibility wrapper', async () => {
    const app = createApp({
      runtimeAvailabilityDetector: {
        detect: async () => ({ executable: 'available', taskExecution: 'unverified' }),
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    repositories.createWorkspace({ name: 'Sinapsis' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/workspaces/not-a-real-workspace/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity: 'Newton', mention: 'newton', runtime: 'pi', capabilityTags: ['general'],
      }),
    })

    expect(response.status).toBe(201)
    const agent = await response.json() as Record<string, unknown>
    expect(agent).toMatchObject({ identity: 'Newton', mention: 'newton' })
    expect(agent).not.toHaveProperty('workspaceId')
  })

  it('persists normalized Git repository metadata and ensures the singleton summit channel', async () => {
    const server = await startHttpTestServer(createApp({
      gitClient: {
        inspectRepository: async () => ({
          rootPath: '/projects/sinapsis', currentBranch: 'feature/local-service', defaultBranch: 'main', isClean: false,
        }),
      },
    }))
    closeServer = server.close

    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sinapsis' }),
    })
    const workspace = await workspaceResponse.json() as { id: string }
    const repositoryResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/repositories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: '/projects/sinapsis/packages/web' }),
    })

    expect(repositoryResponse.status).toBe(201)
    await expect(repositoryResponse.json()).resolves.toMatchObject({
      name: 'sinapsis', path: '/projects/sinapsis', currentBranch: 'feature/local-service', defaultBranch: 'main', isClean: false,
    })

    const bootstrapResponse = await fetch(`${server.baseUrl}/api/bootstrap`)
    const bootstrap = await bootstrapResponse.json() as {
      channels: Array<{ name: string; systemKey: string | null; boundWorkspaceIds: string[] }>
      workspaces: Array<{ repositories: Array<{ currentBranch: string; defaultBranch: string; isClean: boolean }> }>
    }
    expect(bootstrap.workspaces[0].repositories[0]).toMatchObject({
      currentBranch: 'feature/local-service', defaultBranch: 'main', isClean: false,
    })
    expect(bootstrap.channels).toEqual([expect.objectContaining({ name: 'summit', systemKey: 'summit', boundWorkspaceIds: [] })])
  })

  it('creates an unbound global Channel without returning a Repository locator', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'release' }),
    })

    expect(response.status).toBe(201)
    const channel = await response.json() as Record<string, unknown>
    expect(channel).toMatchObject({ name: 'release', systemKey: null, boundWorkspaceIds: [] })
    expect(channel).not.toHaveProperty('repositoryId')
  })

  it('binds the Repository Workspace only in the legacy Channel compatibility route', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'engineering' }),
    })

    expect(response.status).toBe(201)
    const channel = await response.json() as Record<string, unknown>
    expect(channel).toMatchObject({ name: 'engineering', boundWorkspaceIds: [workspace.id] })
    expect(channel).not.toHaveProperty('repositoryId')
  })

  it('rejects a missing Repository before the legacy Channel route creates an orphan', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const countChannels = () => repositories.getBootstrap().channels.length
    const before = countChannels()
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/repositories/missing/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'orphan' }),
    })

    expect(response.status).toBe(404)
    expect(countChannels()).toBe(before)
  })

  it('rolls back legacy Channel creation when its Workspace binding fails', async () => {
    const app = createApp({ maxWorkspaceBindingsPerChannel: 0 })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const countChannels = () => repositories.getBootstrap().channels.length
    const before = countChannels()
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'must-roll-back' }),
    })

    expect(response.status).toBe(409)
    expect(countChannels()).toBe(before)
  })

  it('creates a task in the explicitly requested repository channel', async () => {
    const app = createApp({
      gitClient: {
        inspectRepository: async () => ({
          rootPath: '/projects/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
        }),
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    repositories.createChannel({ name: 'general' })
    const build = repositories.createChannel({ name: 'build' })
    repositories.bindChannelWorkspace(build.id, workspace.id, new Date())
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId: build.id,
        title: 'Build',
        description: 'Build',
        acceptanceCriteria: 'Pass',
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ repositoryId: repository.id, channelId: build.id })
  })

  it('creates a Channel task using an explicitly bound Workspace', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'build' })
    repositories.bindChannelWorkspace(channel.id, workspace.id, new Date())
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.id,
        title: 'Build',
        description: 'Build',
        acceptanceCriteria: 'Pass',
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      channelId: channel.id,
    })
  })

  it('requires a Workspace for Channel task creation and rejects unbound legacy task channels', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'build' })
    const server = await startHttpTestServer(app)
    closeServer = server.close
    const taskBody = { channelId: channel.id, title: 'Build', description: 'Build', acceptanceCriteria: 'Pass' }

    const missingWorkspace = await fetch(`${server.baseUrl}/api/channels/${channel.id}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(taskBody),
    })
    const unboundLegacy = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(taskBody),
    })

    expect(missingWorkspace.status).toBe(400)
    expect(unboundLegacy.status).toBe(409)
  })

  it('returns a conflict when concurrent agent creation races at the SQLite mention constraint', async () => {
    let detections = 0
    let releaseDetections: (() => void) | undefined
    const detectionsReady = new Promise<void>((resolve) => {
      releaseDetections = resolve
    })
    const server = await startHttpTestServer(createApp({
      runtimeAvailabilityDetector: {
        detect: async () => {
          detections += 1
          if (detections === 2) releaseDetections?.()
          await detectionsReady
          return { executable: 'available', taskExecution: 'unverified' }
        },
      },
    }))
    closeServer = server.close

    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sinapsis' }),
    })
    const workspace = await workspaceResponse.json() as { id: string }
    const body = JSON.stringify({
      identity: 'Build engineer', mention: '@Build', runtime: 'opencode', capabilityTags: ['typescript'],
    })

    const responses = await Promise.all([
      fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/agents`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }),
      fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/agents`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
  })

  it('persists ordinary channel messages without waking an agent and makes merge explicitly unavailable', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'general' })
    const agent = repositories.createAgent({
      identity: 'Build', mentionName: 'build', runtime: 'opencode', capabilityTags: ['typescript'],
      maxConcurrentTasks: 1, command: 'opencode', args: ['run'], model: '', env: {},
    })
    const task = repositories.createTask({
      repositoryId: repository.id, channelId: channel.id, directAgentId: agent.id, title: 'Task', description: 'Description',
      acceptanceCriteria: 'Criteria', labels: ['typescript'],
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const messageResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '这是一条普通频道消息。', taskId: task.id }),
    })
    const mergeResponse = await fetch(`${server.baseUrl}/api/tasks/${task.id}/merge`, { method: 'POST' })

    expect(messageResponse.status).toBe(201)
    expect(repositories.getTaskDetails(task.id)?.inputs).toEqual([])
    expect(repositories.getBootstrap().agents[0].status).toBe('offline')
    expect(mergeResponse.status).toBe(501)
    await expect(mergeResponse.json()).resolves.toEqual({ error: '第一版只记录验收，合并需要独立人工流程。' })
  })

  it('dispatches an ordinary channel message to the conversation coordinator without creating a task', async () => {
    const dispatched: Array<{ channelId: string; messageId: string; body: string }> = []
    const app = createApp({
      conversationCoordinator: {
        dispatch: async (channelId, message) => {
          dispatched.push({ channelId, messageId: message.id, body: message.body })
        },
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'general' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '请介绍一下当前项目。' }),
    })

    expect(response.status).toBe(201)
    expect(dispatched).toEqual([{ channelId: channel.id, messageId: expect.any(String), body: '请介绍一下当前项目。' }])
    expect(repositories.getTasksForRepository(repository.id)).toEqual([])
  })

  it('returns HTTP 201 after the facade starts a persisted Turn without waiting for background completion', async () => {
    const completion = new Promise<ConversationTurn>(() => undefined)
    const turnCoordinator = {
      start: () => ({
        turn: conversationTurn({ status: 'screening', completedAt: null }),
        completion,
      }),
      cancelChannel: async () => undefined,
      cancelAgentInChannel: async () => undefined,
    } as unknown as ChannelTurnCoordinator
    const app = createApp({
      conversationCoordinator: new ConversationCoordinator({ turnCoordinator }),
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'fast-response' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'background turn' }),
    })

    expect(response.status).toBe(201)
  })

  it('returns a channel-scoped public Turn detail without Runtime-private material', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { channel, agent, message, turn, invocation } = createPersistedTurn(repositories)
    const target = createTestAgent(repositories, 'Target', 'target')
    repositories.addChannelAgent(channel.id, target.id, new Date())
    const handoff = repositories.createConversationHandoff({
      turnId: turn.id,
      sourceInvocationId: invocation.id,
      fromAgentId: agent.id,
      requestedTargetAgentId: target.id,
      toAgentId: target.id,
      question: '请补充测试。',
      round: 2,
      status: 'accepted',
    })
    const privateFailure = 'provider failed: API_TOKEN=secret /Users/private/runtime.log prompt=do-not-share'
    repositories.updateAgentInvocation(invocation.id, {
      status: 'failed',
      completedAt: '2026-07-31T08:02:00.000Z',
      errorCode: privateFailure,
    })
    repositories.updateTurnParticipant(turn.id, agent.id, {
      status: 'failed',
      reason: `response_failed:${privateFailure}`,
    })
    repositories.updateConversationHandoff(handoff.id, {
      status: 'failed',
      reason: `response_failed:${privateFailure}`,
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/turns/${turn.id}`)
    const raw = await response.text()
    const detail = JSON.parse(raw) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(detail).toEqual({
      turn: expect.objectContaining({ id: turn.id, triggerMessageId: message.id }),
      participants: [expect.objectContaining({ agentId: agent.id, proposedAngle: '从公开信息回答' })],
      invocations: [expect.objectContaining({
        id: invocation.id,
        agentId: agent.id,
        status: 'failed',
        errorCategory: 'runtime_failure',
      })],
      handoffs: [expect.objectContaining({
        fromAgentId: agent.id,
        toAgentId: target.id,
        reason: 'response_failed',
      })],
    })
    expect((detail.invocations as Array<Record<string, unknown>>)[0]).not.toHaveProperty('errorCode')
    expect((detail.invocations as Array<Record<string, unknown>>)[0]).not.toHaveProperty('idempotencyKey')
    expect((detail.participants as Array<Record<string, unknown>>)[0]).toMatchObject({ reason: 'response_failed' })
    expect(raw).not.toMatch(/runtimeRawLog|privatePrompt|environment|API_TOKEN|secret|Users\/private|do-not-share/i)
  })

  it('does not expose a Turn through a different Channel', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { turn } = createPersistedTurn(repositories)
    const foreignChannel = repositories.createChannel({ name: 'foreign' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${foreignChannel.id}/turns/${turn.id}`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: `Conversation turn ${turn.id} does not exist in channel ${foreignChannel.id}.` })
  })

  it('cancels an inactive persisted Turn idempotently and settles its pending records', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { channel, turn, agent } = createPersistedTurn(repositories)
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const first = await fetch(`${server.baseUrl}/api/channels/${channel.id}/turns/${turn.id}/cancel`, { method: 'POST' })
    const second = await fetch(`${server.baseUrl}/api/channels/${channel.id}/turns/${turn.id}/cancel`, { method: 'POST' })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({ id: turn.id, status: 'cancelled' })
    expect(repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ agentId: agent.id, status: 'cancelled', errorCode: 'cancelled' }),
    ])
    expect(repositories.listTurnParticipants(turn.id)).toEqual([
      expect.objectContaining({ agentId: agent.id, status: 'cancelled', reason: 'turn_cancelled' }),
    ])
  })

  it('streams persisted Coordinator cancellation events through the real HTTP SSE endpoint', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { channel, turn, invocation, agent } = createPersistedTurn(repositories)
    const participant = repositories.listTurnParticipants(turn.id)[0]!
    const target = createTestAgent(repositories, 'SSE Target', 'sse-target')
    repositories.addChannelAgent(channel.id, target.id, new Date())
    const handoff = repositories.createConversationHandoff({
      turnId: turn.id,
      sourceInvocationId: invocation.id,
      fromAgentId: agent.id,
      requestedTargetAgentId: target.id,
      toAgentId: target.id,
      question: 'private prompt must stay persisted only',
      round: 2,
      status: 'accepted',
    })
    repositories.updateAgentInvocation(invocation.id, {
      errorCode: 'API_TOKEN=secret /Users/private/runtime.log prompt=do-not-share',
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close
    const stream = await fetch(`${server.baseUrl}/events`)
    const reader = stream.body!.getReader()
    const eventsPromise = readSseEventsUntil(reader, (event) => (
      event.type === 'conversation.turn_completed' && event.entityId === turn.id
    ))

    const cancelResponse = await fetch(
      `${server.baseUrl}/api/channels/${channel.id}/turns/${turn.id}/cancel`,
      { method: 'POST' },
    )
    const events = await eventsPromise
    await reader.cancel()

    expect(cancelResponse.status).toBe(200)
    expect(events.map(({ type, entityType, entityId }) => ({ type, entityType, entityId }))).toEqual([
      { type: 'conversation.invocation_updated', entityType: 'agent_invocation', entityId: invocation.id },
      { type: 'conversation.participant_updated', entityType: 'turn_participant', entityId: participant.id },
      { type: 'conversation.turn_updated', entityType: 'conversation_turn', entityId: turn.id },
      { type: 'conversation.turn_completed', entityType: 'conversation_turn', entityId: turn.id },
    ])
    expect(repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ id: handoff.id, status: 'failed', reason: 'turn_cancelled' }),
    ])
    expect(JSON.stringify(events)).not.toMatch(/API_TOKEN|secret|Users\/private|prompt|do-not-share/i)
  })

  it('reports persisted running Invocations as queued after restart in bootstrap activity', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { channel, turn, invocation, agent } = createPersistedTurn(repositories)
    repositories.updateConversationTurn(turn.id, { status: 'responding', currentRound: 1 })
    repositories.updateAgentInvocation(invocation.id, {
      status: 'running',
      startedAt: '2026-07-31T08:01:00.000Z',
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/bootstrap`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      activeTurnsByChannel: {
        [channel.id]: [{
          turnId: turn.id,
          agentId: agent.id,
          phase: 'queued',
          queuePosition: null,
        }],
      },
    })
  })

  it('builds Bootstrap activity from one batch projection instead of per-Channel Turn queries', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const { channel, turn, invocation, agent } = createPersistedTurn(repositories)
    repositories.updateConversationTurn(turn.id, { status: 'responding', currentRound: 1 })
    repositories.updateAgentInvocation(invocation.id, {
      status: 'running',
      startedAt: '2026-07-31T08:01:00.000Z',
    })
    vi.spyOn(repositories, 'listActiveConversationTurns').mockImplementation(() => {
      throw new Error('per-channel active Turn query must not run')
    })
    vi.spyOn(repositories, 'listAgentInvocations').mockImplementation(() => {
      throw new Error('per-Turn Invocation query must not run')
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/bootstrap`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      activeTurnsByChannel: {
        [channel.id]: [{
          turnId: turn.id,
          agentId: agent.id,
          phase: 'queued',
          queuePosition: null,
        }],
      },
    })
  })

  it('returns HTTP 400 for an unknown mention without creating a partial Turn', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'routing' })
    const known = createTestAgent(repositories, 'Known', 'known')
    repositories.addChannelAgent(channel.id, known.id, new Date())
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Unknown 请回答。' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Unknown mention @Unknown.' })
    const triggerMessage = repositories.getBootstrap().recentMessages.find((message) => message.body.includes('@Unknown'))!
    expect(() => repositories.createConversationTurn({
      channelId: channel.id,
      triggerMessageId: triggerMessage.id,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })).not.toThrow()
  })

  it('accepts email addresses and scoped package names as ordinary channel text', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'lexical-boundary' })
    const scope = createTestAgent(repositories, 'Scope', 'scope')
    const example = createTestAgent(repositories, 'Example', 'example')
    repositories.addChannelAgent(channel.id, scope.id, new Date())
    repositories.addChannelAgent(channel.id, example.id, new Date())
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const emailResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '联系 foo@example.com、用户@example.com 或 用户@例子.公司。' }),
    })
    const packageResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '安装 @scope/pkg。' }),
    })

    expect(emailResponse.status).toBe(201)
    expect(packageResponse.status).toBe(201)
  })

  it('routes a non-Task mention to channel conversation and rejects a foreign Task reference', async () => {
    const dispatched: Array<{ channelId: string; body: string }> = []
    const app = createApp({
      conversationCoordinator: {
        dispatch: async (channelId, message) => {
          dispatched.push({ channelId, body: message.body })
        },
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const delivery = repositories.createChannel({ name: 'delivery' })
    const support = repositories.createChannel({ name: 'support' })
    const agent = createTestAgent(repositories, 'Build', 'build')
    repositories.addChannelAgent(delivery.id, agent.id, new Date())
    repositories.addChannelAgent(support.id, agent.id, new Date())
    repositories.setAgentStatus(agent.id, 'idle', new Date())
    const task = repositories.createTask({
      repositoryId: repository.id,
      channelId: delivery.id,
      directAgentId: agent.id,
      title: 'Delivery task',
      description: 'Keep its inputs isolated.',
      acceptanceCriteria: 'No cross-channel input.',
      labels: ['general'],
    })
    expect(repositories.claimNextTask(agent.id, new Date())).toBeDefined()
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const busyMention = await fetch(`${server.baseUrl}/api/channels/${support.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Build 这条消息属于 support。' }),
    })
    const foreignTask = await fetch(`${server.baseUrl}/api/channels/${support.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '错误的任务引用。', taskId: task.id }),
    })

    expect(busyMention.status).toBe(201)
    expect(foreignTask.status).toBe(409)
    expect(dispatched).toEqual([{ channelId: support.id, body: '@Build 这条消息属于 support。' }])
    expect(repositories.getTaskDetails(task.id)?.inputs).toEqual([])
  })

  it('keeps an explicitly Task-bound mention on the existing Task input path', async () => {
    const queuedInputs: Array<{ agentId: string; channelId: string; body: string }> = []
    const conversationMessages: string[] = []
    const executionCoordinator = {
      queueInputForActiveAgent: (agentId: string, channelId: string, body: string) => {
        queuedInputs.push({ agentId, channelId, body })
      },
    } as unknown as TaskExecutionCoordinator
    const app = createApp({
      executionCoordinator,
      conversationCoordinator: {
        dispatch: async (_channelId, message) => {
          conversationMessages.push(message.body)
        },
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'delivery' })
    const agent = createTestAgent(repositories, 'Build', 'build')
    repositories.addChannelAgent(channel.id, agent.id, new Date())
    repositories.setAgentStatus(agent.id, 'busy', new Date())
    const task = repositories.createTask({
      repositoryId: repository.id,
      channelId: channel.id,
      directAgentId: agent.id,
      title: 'Delivery task',
      description: 'Keep Task input routing.',
      acceptanceCriteria: 'The active Agent receives the input.',
      labels: ['general'],
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Build 继续执行。', taskId: task.id }),
    })

    expect(response.status).toBe(201)
    expect(queuedInputs).toEqual([{ agentId: agent.id, channelId: channel.id, body: '@Build 继续执行。' }])
    expect(conversationMessages).toEqual([])
  })

  it('refreshes a persisted runtime and returns a sanitized Agent payload', async () => {
    const app = createApp({
      runtimeAvailabilityDetector: {
        detect: async () => ({ executable: 'available', taskExecution: 'unverified' }),
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const agent = repositories.createAgent({
      identity: 'Claude builder',
      mentionName: 'claude-builder',
      runtime: 'claude-code',
      capabilityTags: ['typescript'],
      maxConcurrentTasks: 1,
      command: 'claude',
      args: ['--verbose'],
      model: '',
      env: { CLAUDE_TOKEN: 'do-not-return-this' },
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/agents/${agent.id}/refresh-runtime`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: agent.id,
      runtime: 'claude-code',
      status: 'idle',
      env: ['CLAUDE_TOKEN'],
    })
    expect(repositories.getBootstrap().agents[0].status).toBe('idle')
  })

  it('persists editable Agent responsibilities without exposing runtime secrets', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const agent = repositories.createAgent({
      identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: ['typescript'],
      maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: { API_TOKEN: 'secret' },
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/agents/${agent.id}/responsibilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ responsibilities: ['前端界面与交互', '组件测试'] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id: agent.id, responsibilities: ['前端界面与交互', '组件测试'], env: ['API_TOKEN'] })
    expect(repositories.getAgent(agent.id)?.responsibilities).toEqual(['前端界面与交互', '组件测试'])
  })

  it('archives a channel as read-only and restores it unless its name has been reused', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'legacy' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const archiveResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/archive`, { method: 'POST' })
    const archivedBootstrap = await fetch(`${server.baseUrl}/api/bootstrap`).then((response) => response.json()) as { channels: Array<{ id: string; archivedAt: string | null }> }
    const messageResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '不应发送' }),
    })
    const taskResponse = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        channelId: channel.id, title: '不应创建', description: '归档频道不应创建任务', acceptanceCriteria: '无', labels: [],
      }),
    })

    expect(archiveResponse.status).toBe(200)
    expect(archivedBootstrap.channels).toContainEqual(expect.objectContaining({ id: channel.id, archivedAt: expect.any(String) }))
    expect(messageResponse.status).toBe(409)
    expect(taskResponse.status).toBe(409)

    const replacement = repositories.createChannel({ name: 'legacy' })
    expect(replacement.id).not.toBe(channel.id)
    const restoreConflict = await fetch(`${server.baseUrl}/api/channels/${channel.id}/restore`, { method: 'POST' })
    expect(restoreConflict.status).toBe(409)
  })

  it('does not archive a channel with an active task', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'delivery' })
    repositories.createTask({ repositoryId: repository.id, channelId: channel.id, title: '运行中任务', description: '保持频道可写', acceptanceCriteria: '完成', labels: [] })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/archive`, { method: 'POST' })

    expect(response.status).toBe(409)
  })

  it('only permits the summit channel to reset its current context', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const summit = repositories.createChannel({ name: 'summit', systemKey: 'summit' })
    const engineering = repositories.createChannel({ name: 'engineering' })
    const task = repositories.createTask({
      repositoryId: repository.id,
      channelId: summit.id,
      title: '排队任务',
      description: '会被逻辑取消。',
      acceptanceCriteria: '不进入新的上下文。',
      labels: [],
    })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const summitResponse = await fetch(`${server.baseUrl}/api/channels/${summit.id}/context-reset`, { method: 'POST' })
    const regularResponse = await fetch(`${server.baseUrl}/api/channels/${engineering.id}/context-reset`, { method: 'POST' })

    expect(summitResponse.status).toBe(200)
    await expect(summitResponse.json()).resolves.toMatchObject({ id: summit.id, contextResetAt: expect.any(String) })
    expect(repositories.getTask(task.id)).toMatchObject({ status: 'cancelled' })
    expect(regularResponse.status).toBe(409)
  })

  it('manages ordinary channel members through human-only routes and keeps summit automatic', async () => {
    const cancellations: Array<{ channelId: string; agentId: string }> = []
    const app = createApp({
      conversationCoordinator: {
        dispatch: async () => undefined,
        cancelAgentInChannel: async (channelId, agentId) => {
          cancellations.push({ channelId, agentId })
        },
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'engineering' })
    const summit = repositories.createChannel({ name: 'summit', systemKey: 'summit' })
    const newton = createTestAgent(repositories, 'Newton', 'newton')
    const clawd = createTestAgent(repositories, 'Clawd', 'clawd')
    repositories.bindChannelWorkspace(channel.id, workspace.id, new Date())
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const addNewton = await fetch(`${server.baseUrl}/api/channels/${channel.id}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: newton.id }),
    })
    const addNewtonAgain = await fetch(`${server.baseUrl}/api/channels/${channel.id}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: newton.id }),
    })
    await fetch(`${server.baseUrl}/api/channels/${channel.id}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: clawd.id }),
    })
    const forgedActor = await fetch(`${server.baseUrl}/api/channels/${channel.id}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: clawd.id, actorType: 'agent' }),
    })
    const summitMutation = await fetch(`${server.baseUrl}/api/channels/${summit.id}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: newton.id }),
    })

    expect(addNewton.status).toBe(200)
    expect(addNewtonAgain.status).toBe(200)
    await expect(addNewtonAgain.json()).resolves.toHaveLength(1)
    expect(forgedActor.status).toBe(400)
    expect(summitMutation.status).toBe(409)

    repositories.createTask({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      channelId: channel.id,
      directAgentId: newton.id,
      title: 'Active task',
      description: 'Membership must remain while this task is unfinished.',
      acceptanceCriteria: 'Accepted',
    })
    const busyRemoval = await fetch(`${server.baseUrl}/api/channels/${channel.id}/agents/${newton.id}`, { method: 'DELETE' })
    const idleRemoval = await fetch(`${server.baseUrl}/api/channels/${channel.id}/agents/${clawd.id}`, { method: 'DELETE' })

    expect(busyRemoval.status).toBe(409)
    expect(idleRemoval.status).toBe(200)
    expect(cancellations).toEqual([{ channelId: channel.id, agentId: clawd.id }])
  })

  it('manages channel workspace bindings idempotently and enforces limits and unfinished work', async () => {
    const app = createApp({ maxWorkspaceBindingsPerChannel: 1 })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const otherWorkspace = repositories.createWorkspace({ name: 'Docs' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'engineering' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const bind = await fetch(`${server.baseUrl}/api/channels/${channel.id}/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: workspace.id }),
    })
    const duplicate = await fetch(`${server.baseUrl}/api/channels/${channel.id}/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: workspace.id }),
    })
    const overLimit = await fetch(`${server.baseUrl}/api/channels/${channel.id}/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: otherWorkspace.id }),
    })

    expect(bind.status).toBe(200)
    expect(duplicate.status).toBe(200)
    await expect(duplicate.json()).resolves.toHaveLength(1)
    expect(overLimit.status).toBe(409)

    repositories.createTask({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      channelId: channel.id,
      title: 'Active task',
      description: 'The binding must remain.',
      acceptanceCriteria: 'Accepted',
    })
    const unbind = await fetch(`${server.baseUrl}/api/channels/${channel.id}/workspaces/${workspace.id}`, { method: 'DELETE' })

    expect(unbind.status).toBe(409)
    expect(repositories.getChannelWorkspaceIds(channel.id)).toEqual([workspace.id])
  })
})

function createTestAgent(repositories: WorkspaceRepositories, identity: string, mentionName: string) {
  return repositories.createAgent({
    identity,
    mentionName,
    runtime: 'pi',
    capabilityTags: ['general'],
    maxConcurrentTasks: 1,
    command: 'pi',
    args: [],
    model: '',
    env: {},
  })
}

function createPersistedTurn(repositories: WorkspaceRepositories) {
  const workspace = repositories.createWorkspace({ name: 'Conversation workspace' })
  repositories.createRepository({ workspaceId: workspace.id, name: 'conversation', path: '/projects/conversation' })
  const channel = repositories.createChannel({ name: 'turn-detail' })
  const agent = repositories.createAgent({
    identity: 'Safe Agent',
    mentionName: 'safe-agent',
    runtime: 'pi',
    capabilityTags: ['general'],
    responsibilities: ['公开回答'],
    maxConcurrentTasks: 1,
    command: 'pi',
    args: [],
    model: '',
    env: { API_TOKEN: 'secret' },
  })
  repositories.addChannelAgent(channel.id, agent.id, new Date())
  const message = repositories.createMessage({
    channelId: channel.id,
    taskId: null,
    senderType: 'human',
    senderId: null,
    authorName: '你',
    body: '请说明当前状态。',
  })
  const turn = repositories.createConversationTurn({
    channelId: channel.id,
    triggerMessageId: message.id,
    threadRootMessageId: null,
    mode: 'ordinary',
    maxRounds: 3,
  })
  repositories.createTurnParticipant({
    turnId: turn.id,
    agentId: agent.id,
    source: 'responsibility',
    rank: 1,
    matcherScore: 10,
    decision: 'speak',
    confidence: 0.9,
    proposedAngle: '从公开信息回答',
    status: 'selected',
  })
  const invocation = repositories.createAgentInvocation({
    turnId: turn.id,
    agentId: agent.id,
    kind: 'response',
    priority: 'human_ordinary',
    round: 1,
    idempotencyKey: `${turn.id}:response:${agent.id}`,
    sourceInvocationId: null,
  })
  return { workspace, channel, agent, message, turn, invocation }
}

function conversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1', channelId: 'channel-1', triggerMessageId: 'message-1', threadRootMessageId: null,
    mode: 'ordinary', status: 'completed', currentRound: 0, maxRounds: 3,
    createdAt: '2026-07-31T08:00:00.000Z', updatedAt: '2026-07-31T08:00:00.000Z',
    completedAt: '2026-07-31T08:00:01.000Z',
    ...overrides,
  }
}

async function readSseEventsUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (event: DomainEvent) => boolean,
): Promise<DomainEvent[]> {
  const decoder = new TextDecoder()
  const events: DomainEvent[] = []
  let buffer = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('SSE stream closed before the expected event.')
    buffer += decoder.decode(chunk.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (!data) continue
      const event = JSON.parse(data.slice('data: '.length)) as DomainEvent
      events.push(event)
      if (done(event)) return events
    }
  }
}

function humanHeaders(app: ReturnType<typeof createApp>, json = false): Record<string, string> {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    'x-sinapsis-human-capability': app.locals.humanCapability as string,
  }
}
