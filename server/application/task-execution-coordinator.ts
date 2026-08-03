import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RuntimeKind } from '../adapters/runtime/runtime-profile'
import type { Agent } from '../domain/agent'
import { DomainError, type Task } from '../domain/task'
import type { TaskClaim, WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../ports/runtime'
import type { WorktreeManager } from '../ports/worktree-manager'
import { ChannelMessageService } from './channel-message-service'

const execFileAsync = promisify(execFile)

export interface TaskExecutionCoordinatorOptions {
  repositories: WorkspaceRepositories
  runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  worktrees: WorktreeManager
  artifactDirectory: string
  messages?: ChannelMessageService
  collectReviewEvidence?: ReviewEvidenceCollector
}

type ReviewEvidence = { commit: string; changedFiles: string; diffSummary: string }
type ReviewEvidenceCollector = (worktreePath: string, targetBranch: string) => Promise<ReviewEvidence>

interface ManagedExecution {
  taskId: string
  agentId: string
  adapter: RuntimeAdapter
  session: RuntimeSession
  agentName: string
  targetBranch: string
  controlledStderr: string[]
  timeout: NodeJS.Timeout | undefined
  outputFlushTimeout: NodeJS.Timeout | undefined
  pendingArtifacts: Map<string, string[]>
  pendingText: string[]
  active: boolean
}

export class TaskExecutionCoordinator {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Partial<Record<RuntimeKind, RuntimeAdapter>>
  private readonly worktrees: WorktreeManager
  private readonly artifactDirectory: string
  private readonly messages: ChannelMessageService
  private readonly collectReviewEvidence: ReviewEvidenceCollector
  private readonly executions = new Map<string, ManagedExecution>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(options: TaskExecutionCoordinatorOptions) {
    this.repositories = options.repositories
    this.runtimes = options.runtimes
    this.worktrees = options.worktrees
    this.artifactDirectory = options.artifactDirectory
    this.messages = options.messages ?? new ChannelMessageService(options.repositories)
    this.collectReviewEvidence = options.collectReviewEvidence ?? collectGitReviewEvidence
  }

  async startClaim(claim: TaskClaim): Promise<void> {
    const task = claim.task
    const agentId = claim.lease.agentId
    try {
      const { agent, repository } = this.requireClaimContext(claim)
      const allocation = task.worktreePath && task.branchName
        ? { worktreePath: task.worktreePath, branchName: task.branchName }
        : await this.worktrees.create({ id: task.id, repositoryId: repository.id, repositoryRoot: repository.path, targetBranch: repository.defaultBranch })
      this.repositories.inTransaction((unitOfWork) => {
        unitOfWork.allocateTaskWorktree(task.id, allocation.branchName, allocation.worktreePath)
        unitOfWork.createTaskSession(task.id, agent.id)
        unitOfWork.transitionTask(task.id, 'running', 'Runtime 已在任务工作树中启动')
        unitOfWork.createMessage({ channelId: task.channelId, threadRootMessageId: task.threadRootMessageId, taskId: task.id, senderType: 'agent', senderId: agent.id, authorName: agent.identity, body: `开始处理「${task.title}」。` })
      })

      const adapter = this.runtimes[agent.runtime]
      if (!adapter) throw new DomainError(`Runtime ${agent.runtime} is not available on this service.`)
      const session = await adapter.start({
        taskId: task.id, mode: 'task', title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria,
        worktreePath: allocation.worktreePath,
        profile: { runtime: agent.runtime, command: agent.command, args: agent.args, model: agent.model, env: agent.env, policy: 'task-worktree' },
      }, (event) => this.enqueue(event.taskId, () => this.handleRuntimeEvent(event)))
      const execution: ManagedExecution = {
        taskId: task.id,
        agentId: agent.id,
        adapter,
        session,
        agentName: agent.identity,
        targetBranch: repository.defaultBranch,
        controlledStderr: [],
        timeout: undefined,
        outputFlushTimeout: undefined,
        pendingArtifacts: new Map(),
        pendingText: [],
        active: true,
      }
      this.executions.set(task.id, execution)
      this.armTimeout(task, execution)
      this.repositories.updateTaskSession(task.id, agent.id, { runtimeSessionId: session.sessionId, status: 'running' })
      this.deliverUnconsumedInputs(task.id)
    } catch (error) {
      this.fail(task.id, agentId, error instanceof Error ? error.message : 'Runtime 启动失败')
    }
  }

  queueInputForActiveAgent(agentId: string, channelId: string, body: string): void {
    const task = this.repositories.getActiveTaskForAgent(agentId)
    if (!task) throw new DomainError('Agent does not have an active task.')
    if (task.channelId !== channelId) throw new DomainError('Agent active task belongs to another channel.')
    const input = this.repositories.createTaskInput(task.id, body)
    this.deliverQueuedInput(task.id, input.id)
  }

  deliverQueuedInput(taskId: string, inputId: string): void {
    const task = this.task(taskId)
    const input = this.repositories.getTaskDetails(taskId)?.inputs.find((candidate) => candidate.id === inputId)
    if (!input || input.consumedAt) return
    if (task.status === 'waiting_input') {
      this.repositories.transitionTask(taskId, 'running', '已将人工输入发送给 Runtime')
    }
    const execution = this.executions.get(taskId)
    if (!execution) return
    execution.adapter.sendInput(execution.session, input.body, (event) => this.enqueue(event.taskId, () => this.handleRuntimeEvent(event)))
    this.repositories.consumeTaskInput(input.id)
    this.repositories.updateTaskSession(taskId, execution.agentId, { status: 'input_queued' })
  }

  async resumeReturnedTask(taskId: string): Promise<void> {
    const execution = this.executions.get(taskId)
    if (!execution) throw new DomainError('The original runtime session is no longer available locally.')
    const claim = this.repositories.reclaimReturnedTask(taskId, execution.agentId, new Date())
    if (!claim) throw new DomainError('Task cannot be resumed by its original agent.')
    this.repositories.transitionTask(taskId, 'running', '人工退回后恢复原 Runtime 会话')
    try {
      await execution.adapter.resume(execution.session, (event) => this.enqueue(event.taskId, () => this.handleRuntimeEvent(event)))
      execution.active = true
      this.armTimeout(this.task(taskId), execution)
      this.deliverUnconsumedInputs(taskId)
      this.repositories.updateTaskSession(taskId, execution.agentId, { status: 'running' })
    } catch (error) {
      this.fail(taskId, execution.agentId, error instanceof Error ? error.message : 'Runtime 会话恢复失败')
      throw error
    }
  }

  async flush(taskId?: string): Promise<void> {
    if (taskId) {
      await this.pending.get(taskId)
      await this.enqueue(taskId, async () => {
        const execution = this.executions.get(taskId)
        if (execution) await this.flushRuntimeOutput(execution)
      })
      return
    }
    const taskIds = new Set([...this.pending.keys(), ...this.executions.keys()])
    await Promise.all([...taskIds].map((pendingTaskId) => this.flush(pendingTaskId)))
  }

  hasExecution(taskId: string, agentId: string): boolean {
    const execution = this.executions.get(taskId)
    return execution?.agentId === agentId && execution.active
  }

  async terminate(taskId: string, agentId: string): Promise<void> {
    const execution = this.executions.get(taskId)
    if (!execution || execution.agentId !== agentId) return
    try {
      await this.flushRuntimeOutput(execution)
      await execution.adapter.cancel(execution.session)
    } finally {
      this.clearExecution(taskId, execution)
    }
  }

  async cancelTask(taskId: string, reason: string): Promise<Task> {
    const task = this.task(taskId)
    const execution = this.executions.get(taskId)
    if (execution) await this.terminate(taskId, execution.agentId)
    const activeLease = this.repositories.getTaskDetails(taskId)?.leases[0]
    if (activeLease) return this.repositories.finishTaskExecution(taskId, activeLease.agentId, 'cancelled', reason)
    return this.repositories.transitionTask(taskId, 'cancelled', reason)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.executions.values()].map(async (execution) => {
      try {
        await this.terminate(execution.taskId, execution.agentId)
        this.repositories.finishTaskExecution(execution.taskId, execution.agentId, 'needs_human', '本机服务正在关闭，Runtime 已终止。')
      } catch {
        // Best effort shutdown: stale leases will be recovered on the next service start.
      }
    }))
  }

  private enqueue(taskId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(taskId) ?? Promise.resolve()
    const next = previous.then(work, work)
    let tracked: Promise<void>
    tracked = next.finally(() => {
      if (this.pending.get(taskId) === tracked) this.pending.delete(taskId)
    })
    this.pending.set(taskId, tracked)
    return tracked
  }

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const execution = this.executions.get(event.taskId)
    if (!execution) return
    switch (event.kind) {
      case 'artifact':
        if (event.artifactType === 'runtime-stderr') execution.controlledStderr.push(event.content)
        this.bufferArtifact(execution, event.artifactType, event.content)
        return
      case 'text':
        execution.pendingText.push(event.text)
        this.scheduleOutputFlush(execution)
        return
      case 'tool_start':
      case 'tool_end':
      case 'queue':
        this.repositories.inTransaction((unitOfWork) => unitOfWork.recordTaskEvent(event.taskId, `runtime.${event.kind}`, { ...event }))
        return
      case 'session':
        this.repositories.updateTaskSession(event.taskId, execution.agentId, { runtimeSessionId: event.sessionId, status: 'running' })
        return
      case 'needs_input':
        this.repositories.transitionTask(event.taskId, 'waiting_input', 'Runtime 请求人工决定')
        const task = this.task(event.taskId)
        this.messages.postAgent(task.channelId, event.taskId, execution.agentId, execution.agentName, `我需要你的决定：${event.prompt}`, task.threadRootMessageId)
        return
      case 'error':
        if (!await this.flushRuntimeOutput(execution)) return
        if (!await this.persistRuntimeArtifact(execution, 'runtime-error', event.message)) return
        this.fail(event.taskId, execution.agentId, event.message)
        return
      case 'settled':
        if (!await this.flushRuntimeOutput(execution)) return
        await this.settle(execution)
        return
    }
  }

  private async settle(execution: ManagedExecution): Promise<void> {
    const task = this.task(execution.taskId)
    let hasCommit: boolean | null
    try {
      hasCommit = task.worktreePath ? await hasTaskBranchCommit(task.worktreePath, execution.targetBranch) : false
    } catch (error) {
      this.failReviewEvidence(task, execution.agentId, error)
      return
    }
    if (!hasCommit) {
      this.fail(task.id, execution.agentId, 'Runtime 已完成，但任务分支没有可供评审的提交。')
      return
    }
    try {
      await this.writeReviewEvidence(task, execution)
    } catch (error) {
      this.failReviewEvidence(task, execution.agentId, error)
      return
    }
    this.repositories.finishTaskExecution(task.id, execution.agentId, 'in_review', 'Runtime 完成并检测到任务分支提交')
    this.messages.postAgent(task.channelId, task.id, execution.agentId, execution.agentName, `已完成「${task.title}」，已提交改动，等待你验收。`, task.threadRootMessageId)
    execution.active = false
    this.disarmTimeout(execution)
  }

  private failReviewEvidence(task: Task, agentId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : '未知错误'
    this.fail(task.id, agentId, `评审证据收集失败：${detail}`, 'task.review_evidence_failed')
  }

  private fail(taskId: string, agentId: string, reason: string, eventType = 'task.execution_failed'): void {
    this.repositories.inTransaction((unitOfWork) => {
      const task = this.task(taskId)
      unitOfWork.recordTaskEvent(taskId, eventType, { reason })
      this.repositories.finishTaskExecution(taskId, agentId, 'needs_human', reason)
      unitOfWork.createMessage({
        channelId: task.channelId,
        threadRootMessageId: task.threadRootMessageId,
        taskId,
        senderType: 'agent',
        senderId: agentId,
        authorName: this.agentName(agentId),
        body: `执行需要人工处理：${reason}`,
      })
    })
    this.clearExecution(taskId)
  }

  private async persistRuntimeArtifact(execution: ManagedExecution, kind: string, content: string): Promise<boolean> {
    try {
      await this.writeArtifact(execution.taskId, kind, content)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      this.fail(execution.taskId, execution.agentId, `运行产物保存失败：${detail}`, 'task.runtime_artifact_persistence_failed')
      return false
    }
  }

  private bufferArtifact(execution: ManagedExecution, kind: string, content: string): void {
    const chunks = execution.pendingArtifacts.get(kind) ?? []
    chunks.push(content)
    execution.pendingArtifacts.set(kind, chunks)
    this.scheduleOutputFlush(execution)
  }

  private scheduleOutputFlush(execution: ManagedExecution): void {
    if (execution.outputFlushTimeout) return
    execution.outputFlushTimeout = setTimeout(() => {
      execution.outputFlushTimeout = undefined
      void this.enqueue(execution.taskId, async () => { await this.flushRuntimeOutput(execution) })
    }, 200)
  }

  private async flushRuntimeOutput(execution: ManagedExecution): Promise<boolean> {
    if (execution.outputFlushTimeout) {
      clearTimeout(execution.outputFlushTimeout)
      execution.outputFlushTimeout = undefined
    }
    if (this.executions.get(execution.taskId) !== execution || !execution.active) return false

    const artifacts = [...execution.pendingArtifacts.entries()]
    const text = execution.pendingText.join('')
    execution.pendingArtifacts.clear()
    execution.pendingText = []

    for (const [kind, chunks] of artifacts) {
      if (!await this.persistRuntimeArtifact(execution, kind, chunks.join(''))) return false
    }
    if (!text) return true
    if (!await this.persistRuntimeArtifact(execution, 'runtime-text', text)) return false
    this.repositories.inTransaction((unitOfWork) => unitOfWork.recordTaskEvent(execution.taskId, 'runtime.text', { text }))
    return true
  }

  private deliverUnconsumedInputs(taskId: string): void {
    for (const input of this.repositories.getTaskDetails(taskId)?.inputs.filter((candidate) => !candidate.consumedAt) ?? []) {
      this.deliverQueuedInput(taskId, input.id)
    }
  }

  private armTimeout(task: Task, execution: ManagedExecution): void {
    this.disarmTimeout(execution)
    execution.timeout = setTimeout(() => {
      void this.handleTimeout(execution)
    }, task.timeoutMs)
  }

  private async handleTimeout(execution: ManagedExecution): Promise<void> {
    if (this.executions.get(execution.taskId) !== execution || !execution.active) return
    try {
      await this.terminate(execution.taskId, execution.agentId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知终止错误'
      this.fail(execution.taskId, execution.agentId, `任务执行超时，且无法终止 Runtime：${detail}`)
      return
    }
    this.repositories.markTimedOut(execution.taskId, execution.agentId, new Date())
    this.fail(execution.taskId, execution.agentId, '任务执行超时，已终止 Runtime 并等待人工处理。')
  }

  private clearExecution(taskId: string, expected?: ManagedExecution): void {
    const execution = this.executions.get(taskId)
    if (!execution || expected && execution !== expected) return
    this.disarmTimeout(execution)
    if (execution.outputFlushTimeout) clearTimeout(execution.outputFlushTimeout)
    execution.outputFlushTimeout = undefined
    execution.pendingArtifacts.clear()
    execution.pendingText = []
    execution.active = false
    this.executions.delete(taskId)
  }

  private disarmTimeout(execution: ManagedExecution): void {
    if (!execution.timeout) return
    clearTimeout(execution.timeout)
    execution.timeout = undefined
  }

  private async writeReviewEvidence(task: Task, execution: ManagedExecution): Promise<void> {
    if (!task.worktreePath) throw new Error('Task worktree is required before collecting review evidence.')
    const evidence = await this.collectReviewEvidence(task.worktreePath, execution.targetBranch)
    const controlledStderr = execution.controlledStderr.length > 0
      ? execution.controlledStderr.join('')
      : '受控进程未产生 stderr 输出。'
    await Promise.all([
      this.writeArtifact(task.id, 'review-commit', evidence.commit),
      this.writeArtifact(task.id, 'review-changed-files', evidence.changedFiles),
      this.writeArtifact(task.id, 'review-controlled-stderr', controlledStderr),
      this.writeArtifact(task.id, 'review-diff-summary', evidence.diffSummary),
    ])
  }

  private async writeArtifact(taskId: string, kind: string, content: string): Promise<void> {
    const directory = path.join(this.artifactDirectory, taskId)
    await mkdir(directory, { recursive: true })
    const artifactPath = path.join(directory, `${Date.now()}-${randomUUID()}-${kind}.log`)
    await writeFile(artifactPath, content, 'utf8')
    this.repositories.createTaskArtifact(taskId, kind, artifactPath)
  }

  private task(taskId: string): Task {
    const task = this.repositories.getTask(taskId)
    if (!task) throw new Error(`Task ${taskId} does not exist.`)
    return task
  }

  private agentName(agentId: string): string {
    return this.repositories.getAgent(agentId)?.identity ?? 'Agent'
  }

  private requireClaimContext(claim: TaskClaim): { task: Task; agent: Agent; repository: { id: string; path: string; defaultBranch: string } } {
    const agent = this.repositories.getAgent(claim.lease.agentId)
    const repository = this.repositories.getRepository(claim.task.repositoryId)
    if (!agent || !repository) throw new Error('Claim agent or repository does not exist.')
    if (repository.workspaceId !== claim.task.workspaceId) {
      throw new DomainError(`Task repository ${repository.id} does not belong to Workspace ${claim.task.workspaceId}.`)
    }
    return { task: claim.task, agent, repository }
  }
}

async function hasTaskBranchCommit(worktreePath: string, targetBranch: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'log', `${targetBranch}..HEAD`, '--format=%H', '-1'], { shell: false })
  return stdout.trim().length > 0
}

async function collectGitReviewEvidence(worktreePath: string, targetBranch: string): Promise<ReviewEvidence> {
  const range = `${targetBranch}..HEAD`
  const [commit, changedFiles, diffSummary] = await Promise.all([
    gitOutput(worktreePath, ['log', '-1', '--format=%H%n%s']),
    gitOutput(worktreePath, ['diff', '--name-status', range]),
    gitOutput(worktreePath, ['diff', '--stat', range]),
  ])
  return { commit, changedFiles, diffSummary }
}

async function gitOutput(worktreePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args], { shell: false })
  return stdout.trim() || '无输出'
}
