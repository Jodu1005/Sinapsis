import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeManager } from '../adapters/git/git-worktree-manager'
import { FakeRuntimeAdapter } from '../adapters/runtime/fake-runtime-adapter'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import { TaskExecutionCoordinator } from '../application/task-execution-coordinator'
import { TaskReviewService } from '../application/task-review-service'
import { TaskScheduler } from '../application/task-scheduler'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import { commitFile, createGitFixture, type GitFixture } from '../test/git-fixture'

const execFileAsync = promisify(execFile)

describe('local workspace flow', () => {
  let dataDirectory: string | undefined
  let database: SqliteDatabase | undefined
  let source: GitFixture | undefined

  afterEach(async () => {
    database?.close()
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
    await source?.dispose()
    dataDirectory = undefined
    database = undefined
    source = undefined
  })

  it('coordinates FIFO tasks in separate worktrees and accepts a committed result without merging', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-local-flow-'))
    database = createSqliteDatabase(path.join(dataDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new NoopEventPublisher())
    source = await createGitFixture()

    const workspace = repositories.createWorkspace({ name: 'Local QA' })
    const repository = repositories.createRepository({
      workspaceId: workspace.id,
      name: 'fixture',
      path: source.repositoryRoot,
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'general' })
    const firstAgent = repositories.createAgent({
      workspaceId: workspace.id,
      identity: 'First builder',
      mentionName: 'first-builder',
      runtime: 'opencode',
      capabilityTags: ['typescript'],
      maxConcurrentTasks: 1,
      command: 'opencode',
      args: ['run'],
      model: '',
      env: {},
    })
    const secondAgent = repositories.createAgent({
      workspaceId: workspace.id,
      identity: 'Second builder',
      mentionName: 'second-builder',
      runtime: 'opencode',
      capabilityTags: ['typescript'],
      maxConcurrentTasks: 1,
      command: 'opencode',
      args: ['run'],
      model: '',
      env: {},
    })
    repositories.setAgentStatus(firstAgent.id, 'idle', new Date('2026-07-25T00:00:00.000Z'))
    repositories.setAgentStatus(secondAgent.id, 'idle', new Date('2026-07-25T00:00:01.000Z'))

    const firstTask = repositories.createTask({
      repositoryId: repository.id,
      channelId: channel.id,
      title: 'First FIFO task',
      description: 'Create a committed implementation.',
      acceptanceCriteria: 'A commit exists on the task branch.',
      labels: ['typescript'],
    })
    const secondTask = repositories.createTask({
      repositoryId: repository.id,
      channelId: channel.id,
      title: 'Second FIFO task',
      description: 'Create a separate implementation.',
      acceptanceCriteria: 'A separate worktree exists.',
      labels: ['typescript'],
    })
    const runtime = new FakeRuntimeAdapter()
    const coordinator = new TaskExecutionCoordinator({
      repositories,
      runtimes: { opencode: runtime, pi: runtime },
      worktrees: new GitWorktreeManager({ dataDir: dataDirectory, repositoryRoots: [source.repositoryRoot] }),
      artifactDirectory: path.join(dataDirectory, 'artifacts'),
    })
    const scheduler = new TaskScheduler(repositories)

    const firstClaim = scheduler.claimNext(firstAgent.id, new Date('2026-07-25T00:00:02.000Z'))
    expect(firstClaim?.task.id).toBe(firstTask.id)
    await coordinator.startClaim(firstClaim!)

    const secondClaim = scheduler.claimNext(secondAgent.id, new Date('2026-07-25T00:00:03.000Z'))
    expect(secondClaim?.task.id).toBe(secondTask.id)
    await coordinator.startClaim(secondClaim!)

    const firstDetails = repositories.getTaskDetails(firstTask.id)!
    const secondDetails = repositories.getTaskDetails(secondTask.id)!
    expect(firstDetails.task).toMatchObject({ status: 'running', branchName: expect.stringMatching(/^sinapsis\/task-/) })
    expect(secondDetails.task).toMatchObject({ status: 'running', branchName: expect.stringMatching(/^sinapsis\/task-/) })
    expect(firstDetails.task.worktreePath).not.toBe(secondDetails.task.worktreePath)
    expect(firstDetails.task.branchName).not.toBe(secondDetails.task.branchName)

    coordinator.queueInputForActiveAgent(firstAgent.id, 'Please add the regression check before settling.')
    await coordinator.flush(firstTask.id)
    expect(runtime.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ input: 'Please add the regression check before settling.' }),
    ]))

    const firstWorktree = firstDetails.task.worktreePath!
    await writeFile(path.join(firstWorktree, 'implementation.txt'), 'verified\n')
    await commitFile(firstWorktree, 'implementation.txt', 'Add verified implementation')
    const commit = (await execFileAsync('git', ['-C', firstWorktree, 'rev-parse', 'HEAD'], { shell: false })).stdout.trim()
    runtime.emit(firstTask.id, { kind: 'artifact', artifactType: 'runtime-stderr', content: 'fake runtime test output' })
    runtime.emit(firstTask.id, { kind: 'settled' })
    await coordinator.flush(firstTask.id)

    expect(repositories.getTask(firstTask.id)?.status).toBe('in_review')
    const review = new TaskReviewService(repositories, coordinator)
    await review.review(firstTask.id, 'accept', 'Evidence is sufficient.')

    expect(repositories.getTask(firstTask.id)?.status).toBe('accepted')
    expect(repositories.getTaskDetails(firstTask.id)?.decisions).toEqual([
      expect.objectContaining({ decision: 'accept' }),
    ])
    await expect(execFileAsync('git', ['-C', source.repositoryRoot, 'merge-base', '--is-ancestor', commit, 'main'], { shell: false })).rejects.toThrow()
    const sourceBranch = (await execFileAsync('git', ['-C', source.repositoryRoot, 'branch', '--show-current'], { shell: false })).stdout.trim()
    expect(sourceBranch).toBe('main')
  })
})

class NoopEventPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
