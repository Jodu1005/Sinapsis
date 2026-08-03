import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import { DomainError } from '../domain/task'
import { ChannelWorkspaceService } from './channel-workspace-service'

describe('ChannelWorkspaceService', () => {
  let database: SqliteDatabase | undefined

  afterEach(() => {
    database?.close()
    database = undefined
  })

  it('enforces the configured binding limit only for new bindings', () => {
    const fixture = createFixture()
    const service = new ChannelWorkspaceService(fixture.repositories, 5)
    const workspaces = [
      fixture.workspace,
      ...Array.from({ length: 5 }, (_, index) => fixture.repositories.createWorkspace({ name: `Workspace ${index + 2}` })),
    ]

    for (const workspace of workspaces.slice(0, 5)) service.bind(fixture.channel.id, workspace.id, 'human')

    expect(service.bind(fixture.channel.id, workspaces[0]!.id, 'human')).toHaveLength(5)
    expect(() => service.bind(fixture.channel.id, workspaces[5]!.id, 'human')).toThrow('at most 5 workspaces')
  })

  it('blocks unbinding unfinished work and leaves local execution records untouched', () => {
    const fixture = createFixture()
    const idleWorkspace = fixture.repositories.createWorkspace({ name: 'Docs' })
    const service = new ChannelWorkspaceService(fixture.repositories, 5)
    service.bind(fixture.channel.id, fixture.workspace.id, 'human')
    service.bind(fixture.channel.id, idleWorkspace.id, 'human')
    const task = fixture.repositories.createTask({
      workspaceId: fixture.workspace.id,
      repositoryId: fixture.repository.id,
      channelId: fixture.channel.id,
      title: 'Ship',
      description: 'Keep this binding until the task is done.',
      acceptanceCriteria: 'Accepted',
    })

    expect(() => service.unbind(fixture.channel.id, fixture.workspace.id, 'human')).toThrow(DomainError)
    expect(service.unbind(fixture.channel.id, idleWorkspace.id, 'human')).not.toContainEqual(
      expect.objectContaining({ id: idleWorkspace.id }),
    )
    expect(fixture.repositories.getTask(task.id)).toMatchObject({ id: task.id, workspaceId: fixture.workspace.id })
  })

  function createFixture() {
    database = createSqliteDatabase(':memory:')
    const repositories = new SqliteRepositories(database, { publish: () => undefined })
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/workspace/app' })
    const channel = repositories.createChannel({ name: 'engineering' })
    return { repositories, workspace, repository, channel }
  }
})
