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

  it('coordinates FIFO tasks in separate worktrees and completes a settled result without merging', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-local-flow-'))
    database = createSqliteDatabase(path.join(dataDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new NoopEventPublisher())
    source = await createGitFixture()
    const remote = path.join(source.directory, 'remote.git')
    await execFileAsync('git', ['init', '--bare', remote], { shell: false })
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: source.repositoryRoot, shell: false })
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: source.repositoryRoot, shell: false })
    const initialRemoteMain = (await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { shell: false })).stdout.trim()

    const workspace = repositories.createWorkspace({ name: 'Local QA' })
    const repository = repositories.createRepository({
      workspaceId: workspace.id,
      name: 'fixture',
      path: source.repositoryRoot,
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ name: 'general' })
    const firstAgent = repositories.createAgent({
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
    repositories.bindChannelWorkspace(channel.id, workspace.id, new Date('2026-07-25T00:00:00.000Z'))
    repositories.addChannelAgent(channel.id, firstAgent.id, new Date('2026-07-25T00:00:00.000Z'))
    repositories.addChannelAgent(channel.id, secondAgent.id, new Date('2026-07-25T00:00:01.000Z'))

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
    expect(firstDetails.task).toMatchObject({ workspaceId: workspace.id, repositoryId: repository.id })
    expect(secondDetails.task).toMatchObject({ workspaceId: workspace.id, repositoryId: repository.id })
    expect(firstDetails.task).toMatchObject({ status: 'running', branchName: expect.stringMatching(/^sinapsis\/task-/) })
    expect(secondDetails.task).toMatchObject({ status: 'running', branchName: expect.stringMatching(/^sinapsis\/task-/) })
    expect(firstDetails.task.worktreePath).not.toBe(secondDetails.task.worktreePath)
    expect(firstDetails.task.branchName).not.toBe(secondDetails.task.branchName)

    coordinator.queueInputForActiveAgent(firstAgent.id, channel.id, 'Please add the regression check before settling.')
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
    expect(repositories.getTaskDetails(firstTask.id)?.decisions).toEqual([])
    await expect(execFileAsync('git', ['-C', source.repositoryRoot, 'merge-base', '--is-ancestor', commit, 'main'], { shell: false })).rejects.toThrow()
    const sourceBranch = (await execFileAsync('git', ['-C', source.repositoryRoot, 'branch', '--show-current'], { shell: false })).stdout.trim()
    expect(sourceBranch).toBe('main')
    const remoteMain = (await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { shell: false })).stdout.trim()
    expect(remoteMain).toBe(initialRemoteMain)
    const remoteBranches = (await execFileAsync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { shell: false })).stdout
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(remoteBranches).toEqual(['refs/heads/main'])
  })

  it('checks every configured runtime-command pair, without starting a model session', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-runtime-health-'))
    database = createSqliteDatabase(path.join(dataDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new NoopEventPublisher())
    const workspace = repositories.createWorkspace({ name: 'Runtime health' })
    const availableCommand = process.execPath
    const missingCommand = 'sinapsis-missing-runtime-command'

    repositories.createAgent(agentInput(workspace.id, 'first-opencode', 'opencode', availableCommand))
    repositories.createAgent(agentInput(workspace.id, 'second-opencode', 'opencode', missingCommand))
    repositories.createAgent(agentInput(workspace.id, 'first-pi', 'pi', availableCommand))
    repositories.createAgent(agentInput(workspace.id, 'second-pi', 'pi', availableCommand))
    repositories.createAgent(agentInput(workspace.id, 'first-claude', 'claude-code', availableCommand))

    const script = path.resolve(process.cwd(), 'scripts/runtime-health-check.mjs')
    const { stdout } = await execFileAsync(process.execPath, [script], {
      env: { ...process.env, SINAPSIS_DATA_DIR: dataDirectory },
      shell: false,
    })
    const result = JSON.parse(stdout) as {
      runtimes: Array<{ runtime: string; command: string; status: string; agents: Array<{ mentionName: string }> }>
    }

    const checks = new Map(result.runtimes.map((check) => [
      `${check.runtime}\u0000${check.command}`,
      { status: check.status, agents: check.agents.map((agent) => agent.mentionName).sort() },
    ]))
    expect(checks).toEqual(new Map([
      [`opencode\u0000${availableCommand}`, { status: 'available', agents: ['first-opencode'] }],
      [`opencode\u0000${missingCommand}`, { status: 'missing', agents: ['second-opencode'] }],
      [`pi\u0000${availableCommand}`, { status: 'available', agents: ['first-pi', 'second-pi'] }],
      [`claude-code\u0000${availableCommand}`, { status: 'available', agents: ['first-claude'] }],
    ]))
  })
})

function agentInput(workspaceId: string, mentionName: string, runtime: 'opencode' | 'opencode-acp' | 'pi' | 'claude-code', command: string) {
  return {
    workspaceId,
    identity: mentionName,
    mentionName,
    runtime,
    capabilityTags: [],
    maxConcurrentTasks: 1 as const,
    command,
    args: [],
    model: '',
    env: {},
  }
}

class NoopEventPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
