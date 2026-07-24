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
}

interface ManagedExecution {
  taskId: string
  agentId: string
  adapter: RuntimeAdapter
  session: RuntimeSession
  targetBranch: string
}

export class TaskExecutionCoordinator {
  private readonly repositories: WorkspaceRepositories
  private readonly runtimes: Record<'opencode' | 'pi', RuntimeAdapter>
  private readonly worktrees: WorktreeManager
  private readonly artifactDirectory: string
  private readonly messages: ChannelMessageService
  private readonly executions = new Map<string, ManagedExecution>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(options: TaskExecutionCoordinatorOptions) {
    this.repositories = options.repositories
    this.runtimes = options.runtimes
    this.worktrees = options.worktrees
    this.artifactDirectory = options.artifactDirectory
    this.messages = options.messages ?? new ChannelMessageService(options.repositories)
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
      this.executions.set(task.id, { taskId: task.id, agentId: agent.id, adapter, session, targetBranch: repository.defaultBranch })
      this.repositories.updateTaskSession(task.id, agent.id, { runtimeSessionId: session.sessionId, status: 'running' })
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
    await execution.adapter.resume(execution.session, (event) => this.enqueue(event.taskId, () => this.handleRuntimeEvent(event)))
    for (const input of this.repositories.getTaskDetails(taskId)?.inputs.filter((candidate) => !candidate.consumedAt) ?? []) {
      execution.adapter.sendInput(execution.session, input.body, (event) => this.enqueue(event.taskId, () => this.handleRuntimeEvent(event)))
      this.repositories.consumeTaskInput(input.id)
    }
    this.repositories.updateTaskSession(taskId, execution.agentId, { status: 'running' })
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
        await this.writeArtifact(event.taskId, event.artifactType, event.content)
        return
      case 'text':
        await this.writeArtifact(event.taskId, 'runtime-text', event.text)
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
        await this.writeArtifact(event.taskId, 'runtime-error', event.message)
        this.fail(event.taskId, execution.agentId, event.message)
        return
      case 'settled':
        await this.settle(execution)
        return
    }
  }

  private async settle(execution: ManagedExecution): Promise<void> {
    const task = this.task(execution.taskId)
    const hasCommit = task.worktreePath && await hasTaskBranchCommit(task.worktreePath, execution.targetBranch)
    if (!hasCommit) {
      this.fail(task.id, execution.agentId, 'Runtime 已完成，但任务分支没有可供评审的提交。')
      return
    }
    this.repositories.finishTaskExecution(task.id, execution.agentId, 'in_review', 'Runtime 完成并检测到任务分支提交')
    this.messages.postMilestone(task.channelId, task.id, '任务已完成，等待人工验收。')
  }

  private fail(taskId: string, agentId: string, reason: string): void {
    const task = this.task(taskId)
    this.repositories.finishTaskExecution(taskId, agentId, 'needs_human', reason)
    this.messages.postMilestone(task.channelId, taskId, `任务需要人工处理：${reason}`)
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
