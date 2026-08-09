import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SchedulerLoop, TaskScheduler } from './task-scheduler'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'

describe('TaskScheduler', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    vi.useRealTimers()
    database?.close()
    database = undefined
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  })

  it('allows only one concurrent claimant to lease the earliest matching task', async () => {
    const { repositories, agents, createTask } = await createFixture()
    const task = createTask({ title: 'Earliest frontend task', labels: ['frontend'] })
    const scheduler = new TaskScheduler(repositories)

    const claims = await Promise.all([
      Promise.resolve().then(() => scheduler.claimNext(agents.frontend.id, at(1))),
      Promise.resolve().then(() => scheduler.claimNext(agents.frontend.id, at(1))),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.find(Boolean)).toMatchObject({ task: { id: task.id, status: 'claimed' } })
    expect(repositories.getTaskDetails(task.id)?.leases).toHaveLength(1)
  })

  it('claims the oldest queued task whose labels match the idle agent', async () => {
    const { repositories, agents, createTask } = await createFixture()
    const older = createTask({ title: 'Older frontend task', labels: ['frontend'] })
    createTask({ title: 'Backend task', labels: ['backend'] })
    const newer = createTask({ title: 'Newer frontend task', labels: ['frontend'] })
    const scheduler = new TaskScheduler(repositories)

    const claim = scheduler.claimNext(agents.frontend.id, at(2))

    expect(claim?.task.id).toBe(older.id)
    expect(repositories.getTask(older.id)?.directAgentId).toBe(agents.frontend.id)
    expect(repositories.getTask(newer.id)?.status).toBe('queued')
  })

  it('does not claim when the agent is busy or no queued labels match', async () => {
    const { repositories, agents, createTask } = await createFixture()
    createTask({ title: 'Backend task', labels: ['backend'] })
    repositories.setAgentStatus(agents.frontend.id, 'busy', at(2))
    const scheduler = new TaskScheduler(repositories)

    expect(scheduler.claimNext(agents.frontend.id, at(3))).toBeUndefined()

    repositories.setAgentStatus(agents.frontend.id, 'idle', at(4))
    expect(scheduler.claimNext(agents.frontend.id, at(5))).toBeUndefined()
  })

  it('reserves direct tasks for their addressed idle agent', async () => {
    const { repositories, agents, createTask } = await createFixture()
    const direct = createTask({
      title: 'Direct frontend task', labels: ['frontend'], directAgentId: agents.frontend.id,
    })
    const scheduler = new TaskScheduler(repositories)

    expect(scheduler.claimNext(agents.backend.id, at(2))).toBeUndefined()
    expect(scheduler.claimNext(agents.frontend.id, at(3))?.task.id).toBe(direct.id)
  })

  it('does not let an Agent outside the Channel membership claim a matching task', async () => {
    const { repositories, createTask } = await createFixture()
    const outsider = repositories.createAgent({
      identity: 'Outsider', mentionName: 'outsider', runtime: 'opencode',
      capabilityTags: ['frontend'], maxConcurrentTasks: 1, command: 'opencode', args: ['run'], model: '', env: {},
    })
    repositories.setAgentStatus(outsider.id, 'idle', at(0))
    createTask({ title: 'Frontend task', labels: ['frontend'], directAgentId: outsider.id })
    const scheduler = new TaskScheduler(repositories)

    expect(scheduler.claimNext(outsider.id, at(2))).toBeUndefined()
  })

  it('lets a global Agent claim a summit task without a persisted membership row', async () => {
    const { database: sqlite, repositories, repository, agents } = await createFixture()
    const summit = repositories.createChannel({ name: 'summit', systemKey: 'summit' })
    const task = repositories.createTask({
      repositoryId: repository.id,
      channelId: summit.id,
      title: 'Summit task',
      description: 'Coordinate the release.',
      acceptanceCriteria: 'Plan recorded.',
      labels: ['frontend'],
    })
    const scheduler = new TaskScheduler(repositories)

    expect(sqlite.database.prepare(
      'SELECT 1 FROM channel_agent_memberships WHERE channel_id = ? AND agent_id = ?',
    ).get(summit.id, agents.frontend.id)).toBeUndefined()
    expect(scheduler.claimNext(agents.frontend.id, at(2))?.task.id).toBe(task.id)
  })

  it('lets an explicitly addressed agent claim a task even when its labels do not match', async () => {
    const { repositories, agents, createTask } = await createFixture()
    const direct = createTask({
      title: 'Direct task with a specialized label', labels: ['java'], directAgentId: agents.frontend.id,
    })
    const scheduler = new TaskScheduler(repositories)

    expect(scheduler.claimNext(agents.frontend.id, at(2))?.task.id).toBe(direct.id)
  })

  it('hands a new claim to the execution coordinator hook', async () => {
    const { repositories, agents, createTask } = await createFixture()
    const task = createTask({ title: 'Start through coordinator', labels: ['frontend'] })
    const received: string[] = []
    const scheduler = new TaskScheduler(repositories, { startClaim: async (claim) => { received.push(claim.task.id) } })

    scheduler.claimNext(agents.frontend.id, at(2))
    await Promise.resolve()

    expect(received).toEqual([task.id])
  })

  it('keeps one active lease per agent even if its status is reset incorrectly', async () => {
    const { repositories, agents, createTask } = await createFixture()
    createTask({ title: 'First task', labels: ['frontend'] })
    createTask({ title: 'Second task', labels: ['frontend'] })
    const scheduler = new TaskScheduler(repositories)

    expect(scheduler.claimNext(agents.frontend.id, at(2))).toBeDefined()
    repositories.setAgentStatus(agents.frontend.id, 'idle', at(3))

    expect(scheduler.claimNext(agents.frontend.id, at(4))).toBeUndefined()
  })

  it('lets the agent that has been idle longest claim the next eligible task first', async () => {
    const { repositories, agents, createTask } = await createFixture()
    const task = createTask({ title: 'General task', labels: [] })
    repositories.setAgentStatus(agents.backend.id, 'idle', at(1))
    repositories.setAgentStatus(agents.frontend.id, 'idle', at(2))
    const scheduler = new TaskScheduler(repositories)
    const loop = new SchedulerLoop(scheduler, repositories, 1_000, () => at(3))

    loop.tick()

    expect(repositories.getTask(task.id)).toMatchObject({ status: 'claimed' })
    expect(repositories.getTaskDetails(task.id)?.leases).toEqual([
      expect.objectContaining({ agentId: agents.backend.id }),
    ])
  })

  it('rechecks FIFO candidates when a conditional claim update loses its race', async () => {
    const { database: sqlite, repositories, agents, createTask } = await createFixture()
    const task = createTask({ title: 'Retry the conditional claim', labels: ['frontend'] })
    const scheduler = new TaskScheduler(repositories)
    const prepare = sqlite.database.prepare.bind(sqlite.database)
    let rejectedFirstClaim = false

    vi.spyOn(sqlite.database, 'prepare').mockImplementation(((source: string) => {
      const statement = prepare(source)
      if (!source.includes("UPDATE tasks SET status = 'claimed'")) return statement
      return {
        ...statement,
        run: (...parameters: unknown[]) => {
          if (!rejectedFirstClaim) {
            rejectedFirstClaim = true
            return { changes: 0 }
          }
          return statement.run(...(parameters as Parameters<typeof statement.run>))
        },
      }
    }) as typeof sqlite.database.prepare)

    expect(scheduler.claimNext(agents.frontend.id, at(2))?.task.id).toBe(task.id)
    expect(rejectedFirstClaim).toBe(true)
  })

  it('resolves a task lease TTL from the workspace default before the process timeout', async () => {
    const { repositories, agents, createTask } = await createFixture({ workspaceLeaseTtlMs: 45_000 })
    const task = createTask({ title: 'Workspace lease policy', labels: ['frontend'], timeoutMs: 120_000 })
    const scheduler = new TaskScheduler(repositories)

    const claim = scheduler.claimNext(agents.frontend.id, at(0))

    expect(claim?.lease.expiresAt).toBe(at(45).toISOString())
    expect(repositories.getTask(task.id)?.timeoutMs).toBe(120_000)
  })

  it('lets an explicit task lease TTL override the workspace default', async () => {
    const { agents, createTask, repositories } = await createFixture({ workspaceLeaseTtlMs: 45_000 })
    const task = createTask({ title: 'Short lease', labels: ['frontend'], leaseTtlMs: 12_000 })
    const scheduler = new TaskScheduler(repositories)

    const claim = scheduler.claimNext(agents.frontend.id, at(0))

    expect(claim?.lease.expiresAt).toBe(at(12).toISOString())
    expect(repositories.getTask(task.id)?.leaseTtlMs).toBe(12_000)
  })

  it('heartbeats every ten seconds for every active lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at(0))
    const { repositories, agents, createTask } = await createFixture()
    const task = createTask({ title: 'Keep the lease alive', labels: ['frontend'] })
    const scheduler = new TaskScheduler(repositories)
    const loop = new SchedulerLoop(scheduler, repositories)

    loop.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await loop.stop()

    expect(repositories.getTaskDetails(task.id)?.leases).toEqual([
      expect.objectContaining({ agentId: agents.frontend.id, expiresAt: at(40).toISOString() }),
    ])
  })

  it('only renews leases owned by the current execution coordinator when an owner is supplied', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at(0))
    const { repositories, agents, createTask } = await createFixture()
    const task = createTask({ title: 'Do not revive a lease after restart', labels: ['frontend'] })
    const scheduler = new TaskScheduler(repositories)
    const loop = new SchedulerLoop(scheduler, repositories, 1_000, () => new Date(), {
      hasExecution: () => false,
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await loop.stop()

    expect(repositories.getTaskDetails(task.id)?.leases).toEqual([
      expect.objectContaining({ agentId: agents.frontend.id, expiresAt: at(30).toISOString() }),
    ])
  })

  async function createFixture(options: { workspaceLeaseTtlMs?: number } = {}) {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-scheduler-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const workspace = repositories.createWorkspace({ name: 'Sinapsis', leaseTtlMs: options.workspaceLeaseTtlMs })
    const repository = repositories.createRepository({ workspaceId: workspace.id, name: 'app', path: '/projects/app' })
    const channel = repositories.createChannel({ name: 'general' })
    const frontend = repositories.createAgent({
      identity: 'Frontend agent', mentionName: 'frontend', runtime: 'opencode',
      capabilityTags: ['frontend'], maxConcurrentTasks: 1, command: 'opencode', args: ['run'], model: '', env: {},
    })
    const backend = repositories.createAgent({
      identity: 'Backend agent', mentionName: 'backend', runtime: 'pi',
      capabilityTags: ['backend'], maxConcurrentTasks: 1, command: 'pi', args: ['--mode', 'rpc'], model: '', env: {},
    })
    repositories.setAgentStatus(frontend.id, 'idle', at(0))
    repositories.setAgentStatus(backend.id, 'idle', at(0))
    repositories.bindChannelWorkspace(channel.id, workspace.id, at(0))
    repositories.addChannelAgent(channel.id, frontend.id, at(0))
    repositories.addChannelAgent(channel.id, backend.id, at(0))

    return {
      database,
      repositories,
      repository,
      channel,
      agents: { frontend, backend },
      createTask: (input: { title: string; labels: string[]; directAgentId?: string; timeoutMs?: number; leaseTtlMs?: number }) => repositories.createTask({
        repositoryId: repository.id, channelId: channel.id, title: input.title, description: 'Description',
        acceptanceCriteria: 'Acceptance criteria', labels: input.labels, directAgentId: input.directAgentId,
        timeoutMs: input.timeoutMs, leaseTtlMs: input.leaseTtlMs,
      }),
    }
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}

function at(second: number): Date {
  return new Date(`2026-07-25T00:00:${String(second).padStart(2, '0')}.000Z`)
}
