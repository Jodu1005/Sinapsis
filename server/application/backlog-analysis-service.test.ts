import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { WorkspaceRepositories } from '../ports/repositories'
import { BacklogAnalysisService } from './backlog-analysis-service'

describe('BacklogAnalysisService', () => {
  let database: SqliteDatabase | undefined

  afterEach(() => database?.close())

  it('publishes a read-only Agent analysis as a task comment without leaving backlog', async () => {
    database = createSqliteDatabase(':memory:')
    const repositories = new SqliteRepositories(database, { publish: () => undefined }, 5)
    const { task, agent } = createBacklogTask(repositories)
    const sessions = { invoke: vi.fn().mockResolvedValue({ text: '## 预分析\n\n- 先确认 API 边界。', parsed: null }) }
    const service = new BacklogAnalysisService({ repositories, sessions })

    service.start(task)

    await vi.waitFor(() => expect(repositories.getTaskDetails(task.id)?.comments).toEqual([
      expect.objectContaining({ taskId: task.id, senderType: 'agent', senderId: agent.id, body: '## 预分析\n\n- 先确认 API 边界。' }),
    ]))
    expect(sessions.invoke).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ id: agent.id, status: 'idle' }),
      executionPolicy: 'read-only-no-tools',
      initialMessage: expect.stringContaining('只做分析，不要开始执行。'),
    }))
    expect(repositories.getTask(task.id)?.status).toBe('backlog')
  })
})

function createBacklogTask(repositories: WorkspaceRepositories) {
  const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
  const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/tmp/sinapsis' })
  const channel = repositories.createChannel({ name: 'planning' })
  repositories.bindChannelWorkspace(channel.id, workspace.id, new Date())
  const agent = repositories.createAgent({
    identity: 'Planning Agent', mentionName: 'planning', runtime: 'pi', capabilityTags: ['frontend'], maxConcurrentTasks: 1,
    command: 'pi', args: [], model: '', env: {},
  })
  repositories.setAgentStatus(agent.id, 'idle', new Date())
  repositories.addChannelAgent(channel.id, agent.id, new Date())
  const root = repositories.createMessage({ channelId: channel.id, senderType: 'system', authorName: 'Sinapsis', body: '任务已创建。' })
  const task = repositories.createTask({
    workspaceId: workspace.id, repositoryId: repository.id, channelId: channel.id, threadRootMessageId: root.id,
    title: '整理任务入口', description: '统一任务创建体验。', acceptanceCriteria: '可讨论后再执行。', labels: ['frontend'], status: 'backlog',
  })
  return { task, agent }
}
