import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import { DomainError } from '../domain/task'
import { ChannelMembershipService } from './channel-membership-service'

describe('ChannelMembershipService', () => {
  let database: SqliteDatabase | undefined

  afterEach(() => {
    database?.close()
    database = undefined
  })

  it('adds and removes ordinary channel members idempotently', async () => {
    const fixture = createFixture()
    const cancelAgentInChannel = vi.fn(async () => undefined)
    const service = new ChannelMembershipService(fixture.repositories, { cancelAgentInChannel })

    expect(service.add(fixture.channel.id, fixture.agent.id, 'human')).toHaveLength(1)
    expect(service.add(fixture.channel.id, fixture.agent.id, 'human')).toHaveLength(1)

    expect(await service.remove(fixture.channel.id, fixture.agent.id, 'human')).toEqual([])
    expect(await service.remove(fixture.channel.id, fixture.agent.id, 'human')).toEqual([])
    expect(cancelAgentInChannel).toHaveBeenCalledTimes(1)
    expect(cancelAgentInChannel).toHaveBeenCalledWith(fixture.channel.id, fixture.agent.id)
  })

  it('keeps summit membership automatic and immutable', async () => {
    const fixture = createFixture()
    const summit = fixture.repositories.createChannel({ name: 'summit' })
    const service = new ChannelMembershipService(fixture.repositories, { cancelAgentInChannel: async () => undefined })

    expect(service.list(summit.id)).toEqual([expect.objectContaining({ id: fixture.agent.id })])
    expect(() => service.add(summit.id, fixture.agent.id, 'human')).toThrow('summit membership is automatic')
    await expect(service.remove(summit.id, fixture.agent.id, 'human')).rejects.toThrow('summit membership is automatic')
  })

  it('does not cancel or remove a member with unfinished work in a bound workspace', async () => {
    const fixture = createFixture()
    fixture.repositories.addChannelAgent(fixture.channel.id, fixture.agent.id, new Date())
    fixture.repositories.bindChannelWorkspace(fixture.channel.id, fixture.workspace.id, new Date())
    fixture.repositories.createTask({
      workspaceId: fixture.workspace.id,
      repositoryId: fixture.repository.id,
      channelId: fixture.channel.id,
      directAgentId: fixture.agent.id,
      title: 'Ship',
      description: 'Keep the membership while work remains.',
      acceptanceCriteria: 'Accepted',
    })
    const cancelAgentInChannel = vi.fn(async () => undefined)
    const service = new ChannelMembershipService(fixture.repositories, { cancelAgentInChannel })

    await expect(service.remove(fixture.channel.id, fixture.agent.id, 'human')).rejects.toBeInstanceOf(DomainError)
    expect(cancelAgentInChannel).not.toHaveBeenCalled()
    expect(service.list(fixture.channel.id)).toEqual([expect.objectContaining({ id: fixture.agent.id })])
  })

  function createFixture() {
    database = createSqliteDatabase(':memory:')
    const repositories = new SqliteRepositories(database, { publish: () => undefined })
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/workspace/app' })
    const channel = repositories.createChannel({ name: 'engineering' })
    const agent = repositories.createAgent({
      identity: 'Newton',
      mentionName: 'newton',
      runtime: 'pi',
      capabilityTags: ['typescript'],
      maxConcurrentTasks: 1,
      command: 'pi',
      args: [],
      model: '',
      env: {},
    })
    return { repositories, workspace, repository, channel, agent }
  }
})
