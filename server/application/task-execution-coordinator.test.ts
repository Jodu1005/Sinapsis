import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { FakeRuntimeAdapter } from '../adapters/runtime/fake-runtime-adapter'
import { GitWorktreeManager } from '../adapters/git/git-worktree-manager'
import { createGitFixture, commitFile, type GitFixture } from '../test/git-fixture'
import { TaskScheduler } from './task-scheduler'
import { LeaseReaper } from './lease-reaper'
import { TaskExecutionCoordinator } from './task-execution-coordinator'
import { TaskReviewService } from './task-review-service'
import type { DomainEvent } from '../domain/events'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import type { RuntimeArtifactType } from '../ports/runtime'
import type { WorktreeManager } from '../ports/worktree-manager'

describe('TaskExecutionCoordinator', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined
  let gitFixture: GitFixture | undefined

  afterEach(async () => {
    vi.useRealTimers()
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    await gitFixture?.dispose()
    temporaryDirectory = undefined
    database = undefined
    gitFixture = undefined
  })

  it('starts a claim in an isolated worktree and keeps raw runtime output out of the channel', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)
    expect(claim).toBeDefined()

    await fixture.coordinator.startClaim(claim!)
    fixture.runtime.emit(claim!.task.id, { kind: 'artifact', artifactType: 'runtime-stderr', content: 'npm test --verbose' })
    fixture.runtime.emit(claim!.task.id, { kind: 'text', text: 'Implemented the parsing step.' })
    await fixture.coordinator.flush(claim!.task.id)

    const details = fixture.repositories.getTaskDetails(claim!.task.id)!
    expect(details.task).toMatchObject({ status: 'running', worktreePath: expect.any(String), branchName: expect.stringMatching(/^sinapsis\/task-/) })
    expect(fixture.runtime.starts).toHaveLength(1)
    expect(details.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'runtime-stderr' })]))
    expect(details.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'runtime.text' })]))
    expect(fixture.channelMessages()).toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining('开始执行') })]))
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).not.toContain('npm test --verbose')
    const artifact = details.artifacts.find((candidate) => candidate.kind === 'runtime-stderr')!
    await expect(readFile(artifact.path, 'utf8')).resolves.toContain('npm test --verbose')
  })

  it('batches token deltas and raw chunks into compact runtime records', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)

    fixture.runtime.emit(claim.task.id, { kind: 'text', text: 'Implemented ' })
    fixture.runtime.emit(claim.task.id, { kind: 'text', text: 'the parser.' })
    fixture.runtime.emit(claim.task.id, { kind: 'artifact', artifactType: 'runtime-jsonl', content: '{"type":"message_update"}\n' })
    fixture.runtime.emit(claim.task.id, { kind: 'artifact', artifactType: 'runtime-jsonl', content: '{"type":"agent_settled"}\n' })
    await fixture.coordinator.flush(claim.task.id)

    const details = fixture.repositories.getTaskDetails(claim.task.id)!
    const textEvents = details.events.filter((event) => event.type === 'runtime.text')
    const runtimeTextArtifacts = details.artifacts.filter((artifact) => artifact.kind === 'runtime-text')
    const jsonlArtifacts = details.artifacts.filter((artifact) => artifact.kind === 'runtime-jsonl')

    expect(textEvents).toEqual([expect.objectContaining({ payload: { text: 'Implemented the parser.' } })])
    expect(runtimeTextArtifacts).toHaveLength(1)
    expect(jsonlArtifacts).toHaveLength(1)
    await expect(readFile(runtimeTextArtifacts[0]!.path, 'utf8')).resolves.toBe('Implemented the parser.')
    await expect(readFile(jsonlArtifacts[0]!.path, 'utf8')).resolves.toBe('{"type":"message_update"}\n{"type":"agent_settled"}\n')
  })

  it('terminates only its managed runtime and stops advertising the lease as live', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)

    expect(fixture.coordinator.hasExecution(claim.task.id, fixture.agent.id)).toBe(true)
    await fixture.coordinator.terminate(claim.task.id, fixture.agent.id)

    expect(fixture.runtime.cancellations.map((session) => session.taskId)).toEqual([claim.task.id])
    expect(fixture.coordinator.hasExecution(claim.task.id, fixture.agent.id)).toBe(false)
  })

  it('terminates an execution that exceeds its task timeout and releases its lease', async () => {
    vi.useFakeTimers()
    const fixture = await createFixture({ taskTimeoutMs: 50 })
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)

    await vi.advanceTimersByTimeAsync(50)

    expect(fixture.runtime.cancellations.map((session) => session.taskId)).toEqual([claim.task.id])
    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('needs_human')
    expect(fixture.repositories.getTaskDetails(claim.task.id)?.leases).toEqual([])
    expect(fixture.repositories.getTaskDetails(claim.task.id)?.sessions).toEqual([
      expect.objectContaining({ status: 'timed_out' }),
    ])
    expect(fixture.repositories.getBootstrap().workspaces[0].agents[0].status).toBe('idle')
  })

  it('kills the managed runtime before an expired lease returns its task to FIFO', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)

    await new LeaseReaper(fixture.repositories, fixture.coordinator, fixture.repositories).reap(
      new Date(new Date(claim.lease.expiresAt).getTime() + 1),
    )

    expect(fixture.runtime.cancellations.map((session) => session.taskId)).toEqual([claim.task.id])
    expect(fixture.coordinator.hasExecution(claim.task.id, fixture.agent.id)).toBe(false)
    expect(fixture.repositories.getTask(claim.task.id)).toMatchObject({ status: 'queued', attemptCount: 1 })
    expect(fixture.repositories.getTaskDetails(claim.task.id)?.leases).toEqual([])
  })

  it('requires a real task branch commit before moving a settled task into review', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)

    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)

    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('needs_human')

    const second = fixture.createTask({ title: 'Commit the implementation' })
    fixture.repositories.setAgentStatus(fixture.agent.id, 'idle', new Date())
    const secondClaim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(secondClaim)
    const worktree = fixture.repositories.getTask(second.id)!.worktreePath!
    await writeFile(path.join(worktree, 'implementation.txt'), 'done\n')
    await commitFile(worktree, 'implementation.txt', 'Implement task')
    fixture.runtime.emit(second.id, { kind: 'artifact', artifactType: 'runtime-stderr', content: 'npm test\n  3 passed\n' })
    await fixture.coordinator.flush(second.id)
    fixture.runtime.emit(second.id, { kind: 'settled' })
    await fixture.coordinator.flush(second.id)

    expect(fixture.repositories.getTask(second.id)?.status).toBe('in_review')
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain('等待人工验收')
    const artifacts = fixture.repositories.getTaskDetails(second.id)!.artifacts
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'review-commit', 'review-changed-files', 'review-controlled-stderr', 'review-diff-summary',
    ]))
    const evidence = Object.fromEntries(await Promise.all(artifacts
      .filter((artifact) => artifact.kind.startsWith('review-'))
      .map(async (artifact) => [artifact.kind, await readFile(artifact.path, 'utf8')]),
    ))
    expect(evidence['review-commit']).toMatch(/[0-9a-f]{40}/)
    expect(evidence['review-changed-files']).toContain('implementation.txt')
    expect(evidence['review-controlled-stderr']).toBe('npm test\n  3 passed\n')
    expect(evidence['review-diff-summary']).toContain('implementation.txt')
  })

  it('keeps complete controlled stderr separate from assistant text and does not call it test evidence', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    const worktree = fixture.repositories.getTask(claim.task.id)!.worktreePath!
    await writeFile(path.join(worktree, 'text-only.txt'), 'done\n')
    await commitFile(worktree, 'text-only.txt', 'Add text-only evidence fixture')

    fixture.runtime.emit(claim.task.id, { kind: 'text', text: '我已经运行测试，所有 108 tests passed。' })
    fixture.runtime.emit(claim.task.id, { kind: 'artifact', artifactType: 'runtime-stderr', content: 'warning: test setup unavailable\n' })
    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)

    const stderrEvidence = fixture.repositories.getTaskDetails(claim.task.id)!.artifacts.find((artifact) => artifact.kind === 'review-controlled-stderr')!
    await expect(readFile(stderrEvidence.path, 'utf8')).resolves.toBe('warning: test setup unavailable\n')
  })

  it.each<RuntimeArtifactType>(['runtime-stdout', 'runtime-stderr', 'runtime-jsonl', 'runtime-exit'])(
    'moves a task to human handling and releases its agent when %s artifact persistence fails',
    async (artifactType) => {
      const fixture = await createFixture({ failRawArtifactPersistence: true })
      const claim = fixture.scheduler.claimNext(fixture.agent.id)!
      await fixture.coordinator.startClaim(claim)

      fixture.runtime.emit(claim.task.id, { kind: 'artifact', artifactType, content: 'raw process output' })
      await expect(fixture.coordinator.flush(claim.task.id)).resolves.toBeUndefined()

      const details = fixture.repositories.getTaskDetails(claim.task.id)!
      expect(details.task.status).toBe('needs_human')
      expect(details.leases).toEqual([])
      expect(fixture.repositories.getBootstrap().workspaces[0].agents[0].status).toBe('idle')
      expect(fixture.rawArtifactWrites).toEqual([artifactType])
      expect(details.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task.runtime_artifact_persistence_failed', payload: expect.objectContaining({ reason: expect.stringContaining('raw artifact persistence unavailable') }) }),
      ]))
      expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain('任务需要人工处理：运行产物保存失败：raw artifact persistence unavailable')
    },
  )

  it('moves a settled task to human handling when Git review evidence collection fails', async () => {
    const fixture = await createFixture({
      collectReviewEvidence: async () => { throw new Error('git diff unavailable') },
    })
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    const worktree = fixture.repositories.getTask(claim.task.id)!.worktreePath!
    await writeFile(path.join(worktree, 'git-failure.txt'), 'done\n')
    await commitFile(worktree, 'git-failure.txt', 'Prepare Git failure fixture')

    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)

    expectTaskSettledForEvidenceFailure(fixture, claim.task.id, 'git diff unavailable')
  })

  it('moves a settled task to human handling when review artifact persistence fails', async () => {
    const fixture = await createFixture({ failReviewArtifactPersistence: true })
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    const worktree = fixture.repositories.getTask(claim.task.id)!.worktreePath!
    await writeFile(path.join(worktree, 'sqlite-failure.txt'), 'done\n')
    await commitFile(worktree, 'sqlite-failure.txt', 'Prepare SQLite failure fixture')

    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)

    expectTaskSettledForEvidenceFailure(fixture, claim.task.id, 'review artifact persistence unavailable')
  })

  it('queues an input for a busy mentioned agent and sends it to the active runtime session', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)

    fixture.coordinator.queueInputForActiveAgent(fixture.agent.id, '请优先补上边界测试')
    await fixture.coordinator.flush(claim.task.id)

    expect(fixture.repositories.getTaskDetails(claim.task.id)?.inputs).toEqual([
      expect.objectContaining({ body: '请优先补上边界测试', consumedAt: expect.any(String) }),
    ])
    expect(fixture.runtime.inputs).toEqual([
      expect.objectContaining({ input: '请优先补上边界测试' }),
    ])
  })

  it('delivers an input queued before runtime registration exactly once after startup', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    const originalStart = fixture.runtime.start.bind(fixture.runtime)
    let releaseRuntimeStart: (() => void) | undefined
    const runtimeStartReached = new Promise<void>((resolve) => {
      fixture.runtime.start = async (request, sink) => {
        resolve()
        await new Promise<void>((continueStart) => { releaseRuntimeStart = continueStart })
        return originalStart(request, sink)
      }
    })

    const starting = fixture.coordinator.startClaim(claim)
    await runtimeStartReached
    fixture.coordinator.queueInputForActiveAgent(fixture.agent.id, 'Runtime 启动后请先检查测试')

    expect(fixture.runtime.inputs).toEqual([])
    expect(fixture.repositories.getTaskDetails(claim.task.id)?.inputs).toEqual([
      expect.objectContaining({ body: 'Runtime 启动后请先检查测试', consumedAt: null }),
    ])

    releaseRuntimeStart?.()
    await starting

    expect(fixture.runtime.inputs).toEqual([
      expect.objectContaining({ input: 'Runtime 启动后请先检查测试' }),
    ])
    expect(fixture.repositories.getTaskDetails(claim.task.id)?.inputs).toEqual([
      expect.objectContaining({ body: 'Runtime 启动后请先检查测试', consumedAt: expect.any(String) }),
    ])
  })

  it('marks a runtime decision request as waiting input and resumes execution after the response', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    fixture.runtime.emit(claim.task.id, { kind: 'needs_input', prompt: '选择测试策略' })
    await fixture.coordinator.flush(claim.task.id)

    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('waiting_input')
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain('需要决定：选择测试策略')

    fixture.coordinator.queueInputForActiveAgent(fixture.agent.id, '优先覆盖回归测试')

    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('running')
    expect(fixture.runtime.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ input: '优先覆盖回归测试' })]))
  })

  it('moves a claim to human handling when worktree preparation fails', async () => {
    const fixture = await createFixture({
      worktrees: { create: async () => { throw new Error('worktree unavailable') } },
    })
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!

    await fixture.coordinator.startClaim(claim)

    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('needs_human')
    expect(fixture.repositories.getBootstrap().workspaces[0].agents[0].status).toBe('idle')
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain('worktree unavailable')
  })

  it('returns a reviewed task through its original runtime session without merging', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    const worktree = fixture.repositories.getTask(claim.task.id)!.worktreePath!
    await writeFile(path.join(worktree, 'revision.txt'), 'ready\n')
    await commitFile(worktree, 'revision.txt', 'Prepare review')
    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)

    const reviews = new TaskReviewService(fixture.repositories, fixture.coordinator)
    await reviews.review(claim.task.id, 'return', '请补充测试')

    expect(fixture.runtime.resumes).toHaveLength(1)
    expect(fixture.runtime.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ input: '请补充测试' })]))
    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('running')
    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)
    await reviews.review(claim.task.id, 'accept', '通过')
    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('accepted')
    expect(fixture.repositories.getTaskDetails(claim.task.id)?.decisions.map((decision) => decision.decision)).toEqual(['return', 'accept'])
  })

  it('moves a returned task to human handling when its original runtime cannot resume', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    const worktree = fixture.repositories.getTask(claim.task.id)!.worktreePath!
    await writeFile(path.join(worktree, 'review.txt'), 'ready\n')
    await commitFile(worktree, 'review.txt', 'Prepare review')
    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)
    const reviews = new TaskReviewService(fixture.repositories, {
      resumeReturnedTask: async () => { throw new Error('runtime session unavailable') },
    })

    await expect(reviews.review(claim.task.id, 'return', '请继续修改')).rejects.toThrow('runtime session unavailable')

    expect(fixture.repositories.getTask(claim.task.id)?.status).toBe('needs_human')
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain('无法恢复原 Runtime 会话')
  })

  it('atomically settles a claimed returned task when its runtime resume rejects', async () => {
    const fixture = await createFixture()
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!
    await fixture.coordinator.startClaim(claim)
    const worktree = fixture.repositories.getTask(claim.task.id)!.worktreePath!
    await writeFile(path.join(worktree, 'resume.txt'), 'ready\n')
    await commitFile(worktree, 'resume.txt', 'Prepare resume')
    fixture.runtime.emit(claim.task.id, { kind: 'settled' })
    await fixture.coordinator.flush(claim.task.id)
    fixture.runtime.resume = async () => { throw new Error('runtime session unavailable') }

    const reviews = new TaskReviewService(fixture.repositories, fixture.coordinator)
    await expect(reviews.review(claim.task.id, 'return', '请继续修改')).rejects.toThrow('runtime session unavailable')

    const details = fixture.repositories.getTaskDetails(claim.task.id)!
    expect(details.task.status).toBe('needs_human')
    expect(details.leases).toEqual([])
    expect(fixture.repositories.getBootstrap().workspaces[0].agents[0].status).toBe('idle')
    expect(details.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.status_changed', payload: expect.objectContaining({ to: 'needs_human' }) }),
    ]))
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain('任务需要人工处理：runtime session unavailable')
  })

  it('selects the Claude Code runtime adapter for a claude-code claim', async () => {
    const fixture = await createFixture({ agentRuntime: 'claude-code' })
    const claim = fixture.scheduler.claimNext(fixture.agent.id)!

    await fixture.coordinator.startClaim(claim)

    expect(fixture.runtime.starts).toHaveLength(0)
    expect(fixture.claudeRuntime.starts).toHaveLength(1)
    expect(fixture.claudeRuntime.starts[0]?.profile.runtime).toBe('claude-code')
  })

  async function createFixture(options: {
    worktrees?: WorktreeManager
    collectReviewEvidence?: () => Promise<never>
    failReviewArtifactPersistence?: boolean
    failRawArtifactPersistence?: boolean
    taskTimeoutMs?: number
    agentRuntime?: 'opencode' | 'pi' | 'claude-code'
  } = {}) {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-coordinator-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    const repositories = new SqliteRepositories(database, new RecordingPublisher())
    const rawArtifactWrites: string[] = []
    if (options.failReviewArtifactPersistence || options.failRawArtifactPersistence) {
      const createTaskArtifact = repositories.createTaskArtifact.bind(repositories)
      repositories.createTaskArtifact = (taskId, kind, artifactPath) => {
        if (kind.startsWith('review-')) throw new Error('review artifact persistence unavailable')
        if (kind.startsWith('runtime-')) {
          rawArtifactWrites.push(kind)
          if (options.failRawArtifactPersistence) throw new Error('raw artifact persistence unavailable')
        }
        return createTaskArtifact(taskId, kind, artifactPath)
      }
    }
    const source = await createGitFixture()
    gitFixture = source
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    const repository = repositories.createRepository({
      workspaceId: workspace.id, name: 'demo', path: source.repositoryRoot, currentBranch: 'main', defaultBranch: 'main', isClean: true,
    })
    const channel = repositories.createChannel({ repositoryId: repository.id, name: 'general' })
    const agentRuntime = options.agentRuntime ?? 'opencode'
    const agent = repositories.createAgent({
      workspaceId: workspace.id,
      identity: 'Build',
      mentionName: 'build',
      runtime: agentRuntime,
      capabilityTags: ['typescript'],
      maxConcurrentTasks: 1,
      command: agentRuntime === 'pi' ? 'pi' : agentRuntime === 'claude-code' ? 'claude' : 'opencode',
      args: agentRuntime === 'pi' ? ['--mode', 'rpc'] : agentRuntime === 'opencode' ? ['run'] : [],
      model: '',
      env: {},
    })
    repositories.setAgentStatus(agent.id, 'idle', new Date())
    const runtime = new FakeRuntimeAdapter()
    const claudeRuntime = new FakeRuntimeAdapter()
    const coordinator = new TaskExecutionCoordinator({
      repositories,
      runtimes: { opencode: runtime, pi: runtime, 'claude-code': claudeRuntime },
      worktrees: options.worktrees ?? new GitWorktreeManager({ dataDir: temporaryDirectory, repositoryRoots: [source.repositoryRoot] }),
      artifactDirectory: path.join(temporaryDirectory, 'artifacts'),
      collectReviewEvidence: options.collectReviewEvidence,
    })
    const scheduler = new TaskScheduler(repositories)
    const createTask = (input: { title: string }) => repositories.createTask({
      repositoryId: repository.id, channelId: channel.id, title: input.title, description: 'Implement it',
      acceptanceCriteria: 'Commit the change', labels: ['typescript'], directAgentId: agent.id, timeoutMs: options.taskTimeoutMs,
    })
    const first = createTask({ title: 'First task' })
    return {
      repositories, runtime, claudeRuntime, coordinator, scheduler, agent, first, rawArtifactWrites,
      createTask,
      channelMessages: () => repositories.getBootstrap().workspaces[0].recentMessages.filter((message) => message.channelId === channel.id),
    }
  }

  function expectTaskSettledForEvidenceFailure(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    taskId: string,
    reason: string,
  ): void {
    const details = fixture.repositories.getTaskDetails(taskId)!
    expect(details.task.status).toBe('needs_human')
    expect(details.leases).toEqual([])
    expect(fixture.repositories.getBootstrap().workspaces[0].agents[0].status).toBe('idle')
    expect(details.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.review_evidence_failed', payload: expect.objectContaining({ reason: expect.stringContaining(reason) }) }),
    ]))
    expect(fixture.channelMessages().map((message) => message.body).join('\n')).toContain(`评审证据收集失败：${reason}`)
  }
})

class RecordingPublisher implements DomainEventPublisher {
  publish(_event: DomainEvent): void {}
}
