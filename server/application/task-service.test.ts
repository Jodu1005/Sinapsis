import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { startHttpTestServer } from '../test/http-test-server'
import { TaskService } from './task-service'
import { DomainError, type Task, type TaskStatus } from '../domain/task'
import type { WorkspaceRepositories } from '../ports/repositories'

describe('task API', () => {
  let closeServer: (() => Promise<void>) | undefined
  let closeDatabase: (() => void) | undefined

  afterEach(async () => {
    await closeServer?.()
    closeServer = undefined
    closeDatabase?.()
    closeDatabase = undefined
  })

  it('creates a queued task with inferred capability labels in the repository general channel', async () => {
    const app = createApp({
      gitClient: {
        inspectRepository: async () => ({
          rootPath: '/projects/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
        }),
      },
    })
    closeDatabase = app.locals.closeDatabase as () => void
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sinapsis' }),
    })
    const workspace = await workspaceResponse.json() as { id: string }
    const repositoryResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/repositories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: '/projects/sinapsis' }),
    })
    const repository = await repositoryResponse.json() as { id: string }
    const channelId = await firstChannelId(server.baseUrl, workspace.id)

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId,
        title: '完善 React 界面的 Vitest 测试',
        description: '为任务面板补充 CSS 状态覆盖。',
        acceptanceCriteria: 'Vitest 测试通过。',
      }),
    })

    expect(response.status).toBe(201)
    const task = await response.json() as { id: string }
    expect(task).toMatchObject({
      repositoryId: repository.id,
      status: 'queued',
      labels: ['frontend', 'test'],
    })
    const detailResponse = await fetch(`${server.baseUrl}/api/tasks/${task.id}`)
    await expect(detailResponse.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: 'labels_inferred', payload: expect.objectContaining({ inferredLabels: ['frontend', 'test'] }),
        }),
      ],
    })
  })

  it('persists a human label override instead of inferred labels', async () => {
    const app = createApp({
      gitClient: {
        inspectRepository: async () => ({
          rootPath: '/projects/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
        }),
      },
    })
    closeDatabase = app.locals.closeDatabase as () => void
    const server = await startHttpTestServer(app)
    closeServer = server.close

    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sinapsis' }),
    })
    const workspace = await workspaceResponse.json() as { id: string }
    const repositoryResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/repositories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: '/projects/sinapsis' }),
    })
    const repository = await repositoryResponse.json() as { id: string }
    const channelId = await firstChannelId(server.baseUrl, workspace.id)

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId,
        title: '审查 API',
        description: '检查接口。',
        acceptanceCriteria: '结论已记录。',
        labels: ['release'],
        timeoutMs: 120000,
        maxRetries: 0,
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ labels: ['release'], timeoutMs: 120000, maxRetries: 0 })
  })

  it('lists a repository task and rejects human input before an agent claims it', async () => {
    const { server, repositoryId, channelId } = await createRepositoryServer()
    const createResponse = await fetch(`${server.baseUrl}/api/repositories/${repositoryId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        channelId, title: '检查 API schema', description: '确认数据库字段。', acceptanceCriteria: '结果已记录。',
      }),
    })
    const task = await createResponse.json() as { id: string }

    const listResponse = await fetch(`${server.baseUrl}/api/repositories/${repositoryId}/tasks`)
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toMatchObject([{ id: task.id, labels: ['backend'] }])

    const inputResponse = await fetch(`${server.baseUrl}/api/tasks/${task.id}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '数据库使用 SQLite。' }),
    })
    expect(inputResponse.status).toBe(409)
    await expect(inputResponse.json()).resolves.toEqual({ error: 'Task input can only be queued while an agent is active.' })
  })

  it('cancels a queued task through its explicit task action API', async () => {
    const { server, repositoryId, channelId } = await createRepositoryServer()
    const createResponse = await fetch(`${server.baseUrl}/api/repositories/${repositoryId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        channelId, title: '审查 API', description: '检查接口。', acceptanceCriteria: '结论已记录。',
      }),
    })
    const task = await createResponse.json() as { id: string }

    const cancelResponse = await fetch(`${server.baseUrl}/api/tasks/${task.id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '需求已撤销。' }),
    })

    expect(cancelResponse.status).toBe(200)
    await expect(cancelResponse.json()).resolves.toMatchObject({ id: task.id, status: 'cancelled' })
  })

  it('requeues a task that needs human handling so it can be claimed again', async () => {
    const { server, repositoryId, channelId, repositories } = await createRepositoryServer()
    const createResponse = await fetch(`${server.baseUrl}/api/repositories/${repositoryId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        channelId, title: '恢复未提交的任务', description: '继续完成已有改动。', acceptanceCriteria: '提交任务分支。',
      }),
    })
    const task = await createResponse.json() as { id: string }
    repositories.transitionTask(task.id, 'claimed', 'Agent 已领取')
    repositories.transitionTask(task.id, 'running', 'Runtime 已启动')
    repositories.transitionTask(task.id, 'needs_human', '任务分支没有提交')

    const response = await fetch(`${server.baseUrl}/api/tasks/${task.id}/requeue`, { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id: task.id, status: 'queued' })
  })

  async function createRepositoryServer(): Promise<{
    server: { baseUrl: string }
    repositoryId: string
    channelId: string
    repositories: WorkspaceRepositories
  }> {
    const app = createApp({
      gitClient: {
        inspectRepository: async () => ({
          rootPath: '/projects/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
        }),
      },
    })
    closeDatabase = app.locals.closeDatabase as () => void
    const server = await startHttpTestServer(app)
    closeServer = server.close
    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sinapsis' }),
    })
    const workspace = await workspaceResponse.json() as { id: string }
    const repositoryResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/repositories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: '/projects/sinapsis' }),
    })
    const repository = await repositoryResponse.json() as { id: string }
    return {
      server,
      repositoryId: repository.id,
      channelId: await firstChannelId(server.baseUrl, workspace.id),
      repositories: app.locals.repositories as WorkspaceRepositories,
    }
  }
})

async function firstChannelId(baseUrl: string, workspaceId: string): Promise<string> {
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json()) as {
    workspaces: Array<{ repositories: Array<{ channels: Array<{ id: string }> }> }>
  }
  const channelId = bootstrap.workspaces[0]!.repositories[0]!.channels[0]!.id
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  })
  expect(response.status).toBe(200)
  return channelId
}

describe('TaskService human input queue', () => {
  it.each<TaskStatus>(['claimed', 'running', 'waiting_input'])('accepts input for a %s task', (status) => {
    const repositories = new TaskInputRepositories(status)

    const input = new TaskService(repositories as unknown as WorkspaceRepositories).queueHumanInput('task-1', 'Proceed with SQLite.')

    expect(input).toMatchObject({ taskId: 'task-1', body: 'Proceed with SQLite.', consumedAt: null })
    expect(repositories.createdInputs).toHaveLength(1)
  })

  it.each<TaskStatus>(['queued', 'in_review', 'accepted', 'returned', 'needs_human', 'merged', 'cancelled'])('rejects input for a non-active %s task', (status) => {
    const repositories = new TaskInputRepositories(status)

    expect(() => new TaskService(repositories as unknown as WorkspaceRepositories).queueHumanInput('task-1', 'Proceed with SQLite.'))
      .toThrow(new DomainError('Task input can only be queued while an agent is active.'))
    expect(repositories.createdInputs).toEqual([])
  })
})

describe('TaskService channel ownership', () => {
  let closeDatabase: (() => void) | undefined

  afterEach(() => {
    closeDatabase?.()
    closeDatabase = undefined
  })

  it('creates a task Thread in an explicitly selected bound Workspace and global channel', () => {
    const app = createApp()
    closeDatabase = app.locals.closeDatabase as () => void
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const general = repositories.createChannel({ name: 'general' })
    const build = repositories.createChannel({ name: 'build' })
    repositories.bindChannelWorkspace(build.id, workspace.id, new Date())
    const service = new TaskService(repositories)

    const task = service.createTask({
      workspaceId: workspace.id,
      channelId: build.id,
      title: 'Build',
      description: 'Build',
      acceptanceCriteria: 'Pass',
    })
    const messages = repositories.getBootstrap().workspaces[0]!.recentMessages

    expect(task.workspaceId).toBe(workspace.id)
    expect(task.repositoryId).toBe(repository.id)
    expect(task.channelId).toBe(build.id)
    expect(task.threadRootMessageId).toEqual(expect.any(String))
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: task.threadRootMessageId, channelId: build.id, threadRootMessageId: null, body: '任务「Build」已创建。' }),
    ]))
    expect(general.id).not.toBe(build.id)
  })

  it('rejects a task Workspace that is not bound to the Channel', () => {
    const app = createApp()
    closeDatabase = app.locals.closeDatabase as () => void
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const unbound = repositories.createWorkspace({ name: 'Docs' })
    repositories.createRepository({ workspaceId: unbound.id, name: 'docs', path: '/projects/docs' })
    const channel = repositories.createChannel({ name: 'build' })
    repositories.bindChannelWorkspace(channel.id, workspace.id, new Date())
    const service = new TaskService(repositories)

    expect(() => service.createTask({
      workspaceId: unbound.id,
      channelId: channel.id,
      title: 'Build',
      description: 'Build',
      acceptanceCriteria: 'Pass',
    })).toThrow('Workspace is not bound to this channel')
  })

  it('rejects a directly assigned Agent outside the Channel membership', () => {
    const app = createApp()
    closeDatabase = app.locals.closeDatabase as () => void
    const repositories = app.locals.repositories as WorkspaceRepositories
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'build' })
    repositories.bindChannelWorkspace(channel.id, workspace.id, new Date())
    const outsider = createTestAgent(repositories, 'Outsider', 'outsider')
    const service = new TaskService(repositories)

    expect(() => service.createTask({
      workspaceId: workspace.id,
      channelId: channel.id,
      directAgentId: outsider.id,
      title: 'Build',
      description: 'Build',
      acceptanceCriteria: 'Pass',
    })).toThrow('Agent is not a member of this channel')
  })
})

class TaskInputRepositories {
  readonly createdInputs: Array<{ taskId: string; body: string }> = []

  constructor(private readonly status: TaskStatus) {}

  getTaskDetails() {
    const task: Task = {
      id: 'task-1', workspaceId: 'workspace-1', repositoryId: 'repository-1', channelId: 'channel-1', directAgentId: null,
      title: 'Task', description: 'Description', acceptanceCriteria: 'Acceptance criteria', labels: [],
      status: this.status, queuedAt: '2026-07-25T00:00:00.000Z', attemptCount: 0, maxRetries: 2,
      timeoutMs: 900000, leaseTtlMs: null, branchName: null, worktreePath: null,
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    }
    return { task, sessions: [], leases: [], inputs: [], decisions: [], artifacts: [], events: [] }
  }

  createTaskInput(taskId: string, body: string) {
    this.createdInputs.push({ taskId, body })
    return { id: 'input-1', taskId, body, createdAt: '2026-07-25T00:00:00.000Z', consumedAt: null }
  }
}

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
