import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Agent } from '../domain/agent'
import { DomainError, type Task } from '../domain/task'
import type { TaskClaim, WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../ports/runtime'
import type { WorktreeManager } from '../ports/worktree-manager'
import { ChannelMessageService } from './channel-message-service'

const execFileAsync = promisify(execFile)

export interface TaskExecutionCoordinatorOptions {
  repositories: WorkspaceRepositories
  runtimes: Record<'opencode' | 'pi', RuntimeAdapter>
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
  targetBranch: string
  controlledStderr: string[]
}

export class TaskExecutionCoordinator {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Record<'opencode' | 'pi', RuntimeAdapter>
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
    const { task, agent, repository } = this.requireClaimContext(claim)
    try {
      const allocation = task.worktreePath && task.branchName
        ? { worktreePath: task.worktreePath, branchName: task.branchName }
        : await this.worktrees.create({ id: task.id, repositoryId: repository.id, repositoryRoot: repository.path, targetBranch: repository.defaultBranch })
      this.repositories.inTransaction((unitOfWork) => {
        unitOfWork.allocateTaskWorktree(task.id, allocation.branchName, allocation.worktreePath)
        unitOfWork.createTaskSession(task.id, agent.id)
        unitOfWork.transitionTask(task.id, 'running', 'Runtime 已在任务工作树中启动')
        unitOfWork.createMessage({ channelId: task.channelId, taskId: task.id, senderType: 'system', authorName: 'Sinapsis', body: `@${agent.mentionName} 开始执行任务。` })
      })

      const adapter = this.runtimes[agent.runtime]
      const session = await adapter.start({
        taskId: task.id, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria,
        worktreePath: allocation.worktreePath,
        profile: { runtime: agent.runtime, command: agent.command, args: agent.args, model: agent.model, env: agent.env, policy: 'task-worktree' },
      }, (event) => this.enqueue(event.taskId, () => this.handleRuntimeEvent(event)))
      this.executions.set(task.id, { taskId: task.id, agentId: agent.id, adapter, session, targetBranch: repository.defaultBranch, controlledStderr: [] })
      this.repositories.updateTaskSession(task.id, agent.id, { runtimeSessionId: session.sessionId, status: 'running' })
      this.deliverUnconsumedInputs(task.id)
    } catch (error) {
      this.fail(task.id, agent.id, error instanceof Error ? error.message : 'Runtime 启动失败')
    }
  }

  queueInputForActiveAgent(agentId: string, body: string): void {
    const task = this.repositories.getActiveTaskForAgent(agentId)
    if (!task) throw new DomainError('Agent does not have an active task.')
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
      return
    }
    await Promise.all(this.pending.values())
  }

  private enqueue(taskId: string, work: () => Promise<void>): void {
    const previous = this.pending.get(taskId) ?? Promise.resolve()
    const next = previous.then(work, work)
    let tracked: Promise<void>
    tracked = next.finally(() => {
      if (this.pending.get(taskId) === tracked) this.pending.delete(taskId)
    })
    this.pending.set(taskId, tracked)
  }

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const execution = this.executions.get(event.taskId)
    if (!execution) return
    switch (event.kind) {
      case 'artifact':
        if (!await this.persistRuntimeArtifact(execution, event.artifactType, event.content)) return
        if (event.artifactType === 'runtime-stderr') execution.controlledStderr.push(event.content)
        return
      case 'text':
        if (!await this.persistRuntimeArtifact(execution, 'runtime-text', event.text)) return
        this.repositories.inTransaction((unitOfWork) => unitOfWork.recordTaskEvent(event.taskId, 'runtime.text', { text: event.text }))
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
        this.messages.postMilestone(this.task(event.taskId).channelId, event.taskId, `需要决定：${event.prompt}`)
        return
      case 'error':
        if (!await this.persistRuntimeArtifact(execution, 'runtime-error', event.message)) return
        this.fail(event.taskId, execution.agentId, event.message)
        return
      case 'settled':
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
    this.messages.postMilestone(task.channelId, task.id, '任务已完成，等待人工验收。')
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
        taskId,
        senderType: 'system',
        authorName: 'Sinapsis',
        body: `任务需要人工处理：${reason}`,
      })
    })
  }

  private async persistRuntimeArtifact(execution: ManagedExecution, kind: string, content: string): Promise<boolean> {
    try {
      await this.writeArtifact(execution.taskId, kind, content)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      this.fail(execution.taskId, execution.agentId, `运行产物保存失败：${detail}`, 'task.runtime_artifact_persistence_failed')
      this.executions.delete(execution.taskId)
      return false
    }
  }

  private deliverUnconsumedInputs(taskId: string): void {
    for (const input of this.repositories.getTaskDetails(taskId)?.inputs.filter((candidate) => !candidate.consumedAt) ?? []) {
      this.deliverQueuedInput(taskId, input.id)
    }
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

  private requireClaimContext(claim: TaskClaim): { task: Task; agent: Agent; repository: { id: string; path: string; defaultBranch: string } } {
    for (const workspace of this.repositories.getBootstrap().workspaces) {
      const repository = workspace.repositories.find((candidate) => candidate.id === claim.task.repositoryId)
      if (!repository) continue
      const agent = workspace.agents.find((candidate) => candidate.id === claim.lease.agentId)
      if (agent) return { task: claim.task, agent, repository }
    }
    throw new Error('Claim agent or repository does not exist.')
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
