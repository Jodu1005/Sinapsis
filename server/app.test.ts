import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { startHttpTestServer } from './test/http-test-server'
import type { WorkspaceRepositories } from './ports/repositories'

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

  it('persists Agent configuration without returning environment variable values', async () => {
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

    const agentResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity: 'Build engineer', mention: 'build', runtime: 'opencode', capabilityTags: ['typescript'],
        env: { API_TOKEN: 'do-not-return-this' },
      }),
    })

    expect(agentResponse.status).toBe(201)
    await expect(agentResponse.json()).resolves.toMatchObject({ profile: { env: ['API_TOKEN'] } })

    const bootstrapResponse = await fetch(`${server.baseUrl}/api/bootstrap`)
    const bootstrap = await bootstrapResponse.json() as { workspaces: Array<{ agents: Array<{ env: unknown }> }> }
    expect(bootstrap.workspaces[0].agents[0].env).toEqual(['API_TOKEN'])
  })

  it('persists normalized Git repository metadata and its general channel', async () => {
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
      workspaces: Array<{ repositories: Array<{ currentBranch: string; defaultBranch: string; isClean: boolean; channels: Array<{ name: string }> }> }>
    }
    expect(bootstrap.workspaces[0].repositories[0]).toMatchObject({
      currentBranch: 'feature/local-service', defaultBranch: 'main', isClean: false, channels: [{ name: 'general' }],
    })
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
    repositories.createChannel({ repositoryId: repository.id, name: 'general' })
    const build = repositories.createChannel({ repositoryId: repository.id, name: 'build' })
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
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'general' })
    const agent = repositories.createAgent({
      workspaceId: workspace.id, identity: 'Build', mentionName: 'build', runtime: 'opencode', capabilityTags: ['typescript'],
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
    expect(repositories.getBootstrap().workspaces[0].agents[0].status).toBe('offline')
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
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'general' })
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

  it('refreshes a persisted runtime and returns a sanitized Agent payload', async () => {
    const app = createApp({
      runtimeAvailabilityDetector: {
        detect: async () => ({ executable: 'available', taskExecution: 'unverified' }),
      },
    })
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const agent = repositories.createAgent({
      workspaceId: workspace.id,
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
    expect(repositories.getBootstrap().workspaces[0].agents[0].status).toBe('idle')
  })

  it('persists editable Agent responsibilities without exposing runtime secrets', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const agent = repositories.createAgent({
      workspaceId: workspace.id, identity: 'Newton', mentionName: 'newton', runtime: 'pi', capabilityTags: ['typescript'],
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
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'legacy' })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const archiveResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/archive`, { method: 'POST' })
    const archivedBootstrap = await fetch(`${server.baseUrl}/api/bootstrap`).then((response) => response.json()) as { workspaces: Array<{ repositories: Array<{ channels: Array<{ id: string; archivedAt: string | null }> }> }> }
    const messageResponse = await fetch(`${server.baseUrl}/api/channels/${channel.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '不应发送' }),
    })
    const taskResponse = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        channelId: channel.id, title: '不应创建', description: '归档频道不应创建任务', acceptanceCriteria: '无', labels: [],
      }),
    })

    expect(archiveResponse.status).toBe(200)
    expect(archivedBootstrap.workspaces[0]!.repositories[0]!.channels).toContainEqual(expect.objectContaining({ id: channel.id, archivedAt: expect.any(String) }))
    expect(messageResponse.status).toBe(409)
    expect(taskResponse.status).toBe(409)

    const replacement = repositories.createChannel({ repositoryId: repository.id, name: 'legacy' })
    expect(replacement.id).not.toBe(channel.id)
    const restoreConflict = await fetch(`${server.baseUrl}/api/channels/${channel.id}/restore`, { method: 'POST' })
    expect(restoreConflict.status).toBe(409)
  })

  it('does not archive a channel with an active task', async () => {
    const app = createApp()
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'delivery' })
    repositories.createTask({ repositoryId: repository.id, channelId: channel.id, title: '运行中任务', description: '保持频道可写', acceptanceCriteria: '完成', labels: [] })
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const response = await fetch(`${server.baseUrl}/api/channels/${channel.id}/archive`, { method: 'POST' })

    expect(response.status).toBe(409)
  })
})
