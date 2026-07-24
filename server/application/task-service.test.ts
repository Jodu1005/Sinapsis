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

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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

    const response = await fetch(`${server.baseUrl}/api/repositories/${repository.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
    const { server, repositoryId } = await createRepositoryServer()
    const createResponse = await fetch(`${server.baseUrl}/api/repositories/${repositoryId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        title: '检查 API schema', description: '确认数据库字段。', acceptanceCriteria: '结果已记录。',
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
    const { server, repositoryId } = await createRepositoryServer()
    const createResponse = await fetch(`${server.baseUrl}/api/repositories/${repositoryId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        title: '审查 API', description: '检查接口。', acceptanceCriteria: '结论已记录。',
      }),
    })
    const task = await createResponse.json() as { id: string }

    const cancelResponse = await fetch(`${server.baseUrl}/api/tasks/${task.id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '需求已撤销。' }),
    })

    expect(cancelResponse.status).toBe(200)
    await expect(cancelResponse.json()).resolves.toMatchObject({ id: task.id, status: 'cancelled' })
  })

  async function createRepositoryServer(): Promise<{ server: { baseUrl: string }; repositoryId: string }> {
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
    return { server, repositoryId: repository.id }
  }
})

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

class TaskInputRepositories {
  readonly createdInputs: Array<{ taskId: string; body: string }> = []

  constructor(private readonly status: TaskStatus) {}

  getTaskDetails() {
    const task: Task = {
      id: 'task-1', repositoryId: 'repository-1', channelId: 'channel-1', directAgentId: null,
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
