import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import { DomainError } from '../domain/task'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import { ChannelContextResetService } from './channel-context-reset-service'

describe('ChannelContextResetService', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
    database = undefined
  })

  it('cancels active channel work and hides its prior context without deleting records', async () => {
    const fixture = await createFixture('summit')
    const task = fixture.repositories.createTask({
      repositoryId: fixture.repositoryId,
      channelId: fixture.channel.id,
      title: '正在处理',
      description: '需要被逻辑取消。',
      acceptanceCriteria: '不会留在当前上下文。',
    })
    const cancelChannel = vi.fn(async () => undefined)
    const cancelTask = vi.fn(async () => fixture.repositories.transitionTask(task.id, 'cancelled', '频道上下文已清空'))
    const service = new ChannelContextResetService(fixture.repositories, { cancelChannel }, { cancelTask })

    const channel = await service.reset(fixture.channel.id)

    expect(cancelChannel).toHaveBeenCalledWith(fixture.channel.id)
    expect(cancelTask).toHaveBeenCalledWith(task.id, '频道上下文已清空')
    expect(channel.contextResetAt).toEqual(expect.any(String))
    expect(fixture.repositories.getTask(task.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.getBootstrap().workspaces[0]!.repositories[0]!.tasks).toEqual([])
  })

  it('rejects reset requests for regular channels', async () => {
    const fixture = await createFixture('engineering')
    const service = new ChannelContextResetService(fixture.repositories, { cancelChannel: async () => undefined }, { cancelTask: async () => {
      throw new Error('should not cancel a regular channel')
    } })

    await expect(service.reset(fixture.channel.id)).rejects.toBeInstanceOf(DomainError)
  })

  async function createFixture(channelName: string) {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-reset-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, { publish: () => undefined } satisfies DomainEventPublisher)
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'control-room', path: '/workspace/control-room' })
    const channel = repositories.createChannel({ repositoryId: repository.id, name: channelName })
    return { repositories, repositoryId: repository.id, channel }
  }
})
