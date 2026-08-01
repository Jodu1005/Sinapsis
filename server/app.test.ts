import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { startHttpTestServer } from './test/http-test-server'
import type { WorkspaceRepositories } from './ports/repositories'
import { ConversationCoordinator } from './application/conversation-coordinator'
import type { ChannelTurnCoordinator } from './application/channel-turn-coordinator'
import type { ConversationTurn } from './domain/conversation'

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
      getActiveStates: () => [],
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

  it('does not inject a Channel message or foreign task reference into another Channel active task', async () => {
    const app = createApp()
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

    expect(busyMention.status).toBe(409)
    expect(foreignTask.status).toBe(409)
    expect(repositories.getTaskDetails(task.id)?.inputs).toEqual([])
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

function conversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1', channelId: 'channel-1', triggerMessageId: 'message-1', threadRootMessageId: null,
    mode: 'ordinary', status: 'completed', currentRound: 0, maxRounds: 3,
    createdAt: '2026-07-31T08:00:00.000Z', updatedAt: '2026-07-31T08:00:00.000Z',
    completedAt: '2026-07-31T08:00:01.000Z',
    ...overrides,
  }
}
