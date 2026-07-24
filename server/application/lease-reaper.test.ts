import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { LeaseReaper } from './lease-reaper'
import { TaskScheduler } from './task-scheduler'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import type { ProcessTerminator } from '../ports/process-terminator'
import type { TaskSessionStore } from '../ports/task-session-store'

describe('LeaseReaper', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    database?.close()
    database = undefined
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  })

  it('terminates an expired lease then requeues it with a retry and visible message', async () => {
    const { repositories, scheduler, agent, task } = await createClaimedTask({ maxRetries: 2 })
    const terminator = new RecordingTerminator()
    const sessionStore = new RecordingSessionStore()
    const reaper = new LeaseReaper(repositories, terminator, sessionStore)

    await expect(reaper.reap(at(31))).resolves.toBe(1)

    expect(terminator.terminations).toEqual([{ taskId: task.id, agentId: agent.id }])
    expect(sessionStore.timeouts).toEqual([{ taskId: task.id, agentId: agent.id }])
    expect(repositories.getTask(task.id)).toMatchObject({ status: 'queued', attemptCount: 1, queuedAt: at(31).toISOString() })
    expect(repositories.getBootstrap().workspaces[0].agents.find((candidate) => candidate.id === agent.id)).toMatchObject({ status: 'idle' })
    expect(repositories.getTaskDetails(task.id)?.leases).toEqual([])
    expect(repositories.getTaskDetails(task.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.lease_expired', payload: expect.objectContaining({ outcome: 'requeued' }) }),
    ]))
    expect(repositories.getBootstrap().workspaces[0].recentMessages).toEqual([
      expect.objectContaining({ taskId: task.id, body: expect.stringContaining('FIFO') }),
    ])
    expect(scheduler.claimNext(agent.id, at(32))?.task.id).toBe(task.id)
  })

  it('moves an expired task to human handling after its retry budget is used', async () => {
    const { repositories, agent, task } = await createClaimedTask({ maxRetries: 0 })
    const reaper = new LeaseReaper(repositories, new RecordingTerminator(), new RecordingSessionStore())

    await expect(reaper.reap(at(31))).resolves.toBe(1)

    expect(repositories.getTask(task.id)).toMatchObject({ status: 'needs_human', attemptCount: 0 })
    expect(repositories.getBootstrap().workspaces[0].agents.find((candidate) => candidate.id === agent.id)).toMatchObject({ status: 'idle' })
    expect(repositories.getBootstrap().workspaces[0].recentMessages).toEqual([
      expect.objectContaining({ body: expect.stringContaining('等待人工处理') }),
    ])
  })

  it('does not reap a lease that received a heartbeat before its original TTL expired', async () => {
    const { repositories, scheduler, agent, task } = await createClaimedTask({ maxRetries: 1 })
    const reaper = new LeaseReaper(repositories, new RecordingTerminator(), new RecordingSessionStore())

    expect(scheduler.renew(task.id, agent.id, at(20))).toBe(true)
    await expect(reaper.reap(at(31))).resolves.toBe(0)

    expect(repositories.getTask(task.id)).toMatchObject({ status: 'claimed', attemptCount: 0 })
    expect(repositories.getTaskDetails(task.id)?.leases).toHaveLength(1)
  })

  it('recovers an expired lease even when its stale process has already exited', async () => {
    const { repositories, task } = await createClaimedTask({ maxRetries: 1 })
    const reaper = new LeaseReaper(repositories, new ThrowingTerminator(), new RecordingSessionStore())

    await expect(reaper.reap(at(31))).resolves.toBe(1)

    expect(repositories.getTask(task.id)).toMatchObject({ status: 'queued', attemptCount: 1 })
  })

  async function createClaimedTask(options: { maxRetries: number }) {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-reaper-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'general' })
    const agent = repositories.createAgent({
      workspaceId: workspace.id, identity: 'Backend agent', mentionName: 'backend', runtime: 'opencode',
      capabilityTags: ['backend'], maxConcurrentTasks: 1, command: 'opencode', args: ['run'], model: '', env: {},
    })
    repositories.setAgentStatus(agent.id, 'idle', at(0))
    const task = repositories.createTask({
      repositoryId: repository.id, channelId: channel.id, title: 'Repair API', description: 'Description',
      acceptanceCriteria: 'Acceptance criteria', labels: ['backend'], maxRetries: options.maxRetries,
    })
    const scheduler = new TaskScheduler(repositories)
    expect(scheduler.claimNext(agent.id, at(0))).toBeDefined()
    return { repositories, scheduler, agent, task }
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}

class RecordingTerminator implements ProcessTerminator {
  readonly terminations: Array<{ taskId: string; agentId: string }> = []

  terminate(taskId: string, agentId: string): void {
    this.terminations.push({ taskId, agentId })
  }
}

class ThrowingTerminator implements ProcessTerminator {
  terminate(): void {
    throw new Error('Process already exited.')
  }
}

class RecordingSessionStore implements TaskSessionStore {
  readonly timeouts: Array<{ taskId: string; agentId: string }> = []

  markTimedOut(taskId: string, agentId: string, _occurredAt: Date): void {
    this.timeouts.push({ taskId, agentId })
  }
}

function at(second: number): Date {
  return new Date(`2026-07-25T00:00:${String(second).padStart(2, '0')}.000Z`)
}
