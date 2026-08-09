import { inferCapabilityTags } from './capability-labeler'
import { NotFoundError } from './workspace-service'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { DomainError, type CreateTaskInput, type Task, type TaskDetails, type TaskInput, type TaskStatus } from '../domain/task'
import type { BootstrapWorkspace, WorkspaceRepositories, WorkspaceUnitOfWork } from '../ports/repositories'
import type { ChangedWorktreeFile, GitClient } from '../ports/git-client'

export interface CreateLabeledTaskInput {
  workspaceId: string
  repositoryId?: string
  channelId: string
  directAgentId?: string | null
  title?: string
  description: string
  acceptanceCriteria?: string
  labels?: string[]
  timeoutMs?: number
  leaseTtlMs?: number
  maxRetries?: number
}

export interface BacklogAnalysisStarter {
  start(task: Task): void
}

export interface TaskOutputFile {
  path: string
  status: ChangedWorktreeFile['status']
}

export class TaskService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly backlogAnalysisStarter?: BacklogAnalysisStarter,
    private readonly gitClient?: GitClient,
  ) {}

  createTask(input: CreateLabeledTaskInput): Task {
    const workspace = this.repositories.getBootstrap().workspaces.find((candidate) => candidate.id === input.workspaceId)
    if (!workspace) {
      throw new NotFoundError(`Workspace ${input.workspaceId} does not exist.`)
    }

    const channel = this.repositories.getChannel(input.channelId)
    if (!channel) {
      throw new NotFoundError(`Channel ${input.channelId} does not exist.`)
    }
    if (!this.repositories.getChannelWorkspaceIds(channel.id).includes(workspace.id)) {
      throw new DomainError('Workspace is not bound to this channel.')
    }
    if (input.directAgentId && !this.repositories.getChannelAgentIds(channel.id).includes(input.directAgentId)) {
      throw new DomainError('Agent is not a member of this channel.')
    }

    const repository = input.repositoryId
      ? workspace.repositories.find((candidate) => candidate.id === input.repositoryId)
      : workspace.repositories[0]
    if (!repository) {
      if (input.repositoryId) {
        throw new DomainError(`Repository ${input.repositoryId} does not belong to Workspace ${workspace.id}.`)
      }
      throw new DomainError(`Workspace ${workspace.id} does not have a managed execution Repository.`)
    }
    if (channel.archivedAt) {
      throw new DomainError(`Channel #${channel.name} is archived and read-only.`)
    }

    const title = taskTitle(input.title, input.description)
    const acceptanceCriteria = input.acceptanceCriteria?.trim() || '未填写完成定义。请在执行前根据任务说明与讨论确认完成标准。'
    const inferredLabels = inferCapabilityTags(`${title}\n${input.description}\n${acceptanceCriteria}`)
    const labels = input.labels ?? inferredLabels
    const taskInput: CreateTaskInput = {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      channelId: channel.id,
      directAgentId: input.directAgentId,
      title,
      description: input.description,
      acceptanceCriteria,
      labels,
      status: 'backlog',
      timeoutMs: input.timeoutMs,
      leaseTtlMs: input.leaseTtlMs,
      maxRetries: input.maxRetries,
    }

    const task = this.repositories.inTransaction((unitOfWork) => {
      const root = unitOfWork.createMessage({ channelId: channel.id, senderType: 'system', authorName: 'Sinapsis', body: `任务「${title}」已创建。` })
      return createLabeledTask(unitOfWork, { ...taskInput, threadRootMessageId: root.id }, inferredLabels, input.labels !== undefined)
    })
    try {
      this.backlogAnalysisStarter?.start(task)
    } catch {
      // The task has been persisted; a best-effort analysis must not make creation fail.
    }
    return task
  }

  listTasks(repositoryId: string): Task[] {
    this.requireRepository(repositoryId)
    return this.repositories.getTasksForRepository(repositoryId)
  }

  getTaskDetails(taskId: string): TaskDetails {
    const details = this.repositories.getTaskDetails(taskId)
    if (!details) throw new NotFoundError(`Task ${taskId} does not exist.`)
    return details
  }

  queueHumanInput(taskId: string, body: string): TaskInput {
    const details = this.getTaskDetails(taskId)
    if (!canAcceptHumanInput(details.task.status)) {
      throw new DomainError('Task input can only be queued while an agent is active.')
    }
    return this.repositories.createTaskInput(taskId, body)
  }

  cancelTask(taskId: string, reason: string): Task {
    this.getTaskDetails(taskId)
    return this.repositories.transitionTask(taskId, 'cancelled', reason)
  }

  requeueTask(taskId: string): Task {
    const details = this.getTaskDetails(taskId)
    if (!['backlog', 'needs_human', 'returned'].includes(details.task.status)) {
      throw new DomainError('Only backlog or human-handled tasks can be moved to the todo queue.')
    }
    return this.repositories.transitionTask(taskId, 'queued', '人工将任务移入待办队列')
  }

  async readArtifact(taskId: string, artifactId: string): Promise<{ kind: string; content: string }> {
    const artifact = this.repositories.getTaskArtifact(taskId, artifactId)
    if (!artifact) throw new NotFoundError(`Artifact ${artifactId} does not exist for task ${taskId}.`)
    return { kind: artifact.kind, content: await readFile(artifact.path, 'utf8') }
  }

  async listOutputFiles(taskId: string): Promise<TaskOutputFile[]> {
    const task = this.getTaskDetails(taskId).task
    if (!task.worktreePath || !this.gitClient?.listChangedFiles) return []
    const files = await this.gitClient.listChangedFiles(task.worktreePath)
    return files.filter((file) => isSafeRelativeWorktreePath(file.path))
  }

  async readOutputFile(taskId: string, relativePath: string): Promise<{ path: string; content: string }> {
    const task = this.getTaskDetails(taskId).task
    if (!task.worktreePath) throw new NotFoundError(`Task ${taskId} does not have a worktree.`)
    if (!isSafeRelativeWorktreePath(relativePath)) throw new DomainError('Output file path must stay inside the task worktree.')
    const outputFiles = await this.listOutputFiles(taskId)
    if (!outputFiles.some((file) => file.path === relativePath)) {
      throw new NotFoundError(`Output file ${relativePath} does not exist for task ${taskId}.`)
    }

    const worktreeRoot = await realpath(task.worktreePath)
    const candidatePath = path.resolve(worktreeRoot, relativePath)
    const filePath = await realpath(candidatePath)
    if (!isPathInside(worktreeRoot, filePath)) throw new DomainError('Output file path must stay inside the task worktree.')
    const metadata = await stat(filePath)
    if (!metadata.isFile()) throw new DomainError('Output path is not a file.')
    if (metadata.size > maxOutputFilePreviewBytes) throw new DomainError('Output file is larger than 2 MB and cannot be previewed.')
    return { path: relativePath, content: await readFile(filePath, 'utf8') }
  }

  private requireRepository(repositoryId: string): void {
    findWorkspaceForRepository(this.repositories.getBootstrap().workspaces, repositoryId)
  }
}

const maxOutputFilePreviewBytes = 2 * 1024 * 1024

function taskTitle(inputTitle: string | undefined, description: string): string {
  const suppliedTitle = inputTitle?.trim()
  if (suppliedTitle) return suppliedTitle

  const firstMeaningfulLine = description
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, ''))
    .find(Boolean) ?? description.trim()
  const firstSentence = firstMeaningfulLine.split(/[。！？!?]/, 1)[0]?.trim() || '未命名任务'
  const characters = Array.from(firstSentence)
  return characters.length > 56 ? `${characters.slice(0, 56).join('')}…` : firstSentence
}

function isSafeRelativeWorktreePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  return normalized !== '.' && !normalized.startsWith('../') && normalized !== '..'
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function canAcceptHumanInput(status: TaskStatus): boolean {
  return status === 'claimed' || status === 'running' || status === 'waiting_input'
}

function findWorkspaceForRepository(workspaces: BootstrapWorkspace[], repositoryId: string): BootstrapWorkspace {
  const workspace = workspaces.find((candidate) => candidate.repositories.some((repository) => repository.id === repositoryId))
  if (!workspace) {
    throw new NotFoundError(`Repository ${repositoryId} does not exist.`)
  }
  return workspace
}

function createLabeledTask(
  unitOfWork: WorkspaceUnitOfWork,
  input: CreateTaskInput,
  inferredLabels: string[],
  labelsWereOverridden: boolean,
): Task {
  const task = unitOfWork.createTask(input)
  unitOfWork.recordTaskEvent(task.id, 'labels_inferred', {
    inferredLabels,
    labelsWereOverridden,
    savedLabels: task.labels,
  })
  return task
}
