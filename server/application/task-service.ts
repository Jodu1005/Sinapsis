import { inferCapabilityTags } from './capability-labeler'
import { NotFoundError } from './workspace-service'
import { readFile } from 'node:fs/promises'
import { DomainError, type CreateTaskInput, type Task, type TaskDetails, type TaskInput, type TaskStatus } from '../domain/task'
import type { BootstrapWorkspace, WorkspaceRepositories, WorkspaceUnitOfWork } from '../ports/repositories'

export interface CreateLabeledTaskInput {
  workspaceId: string
  repositoryId?: string
  channelId: string
  directAgentId?: string | null
  title: string
  description: string
  acceptanceCriteria: string
  labels?: string[]
  timeoutMs?: number
  leaseTtlMs?: number
  maxRetries?: number
}

export class TaskService {
  constructor(private readonly repositories: WorkspaceRepositories) {}

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

    const inferredLabels = inferCapabilityTags(`${input.title}\n${input.description}\n${input.acceptanceCriteria}`)
    const labels = input.labels ?? inferredLabels
    const taskInput: CreateTaskInput = {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      channelId: channel.id,
      directAgentId: input.directAgentId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      labels,
      timeoutMs: input.timeoutMs,
      leaseTtlMs: input.leaseTtlMs,
      maxRetries: input.maxRetries,
    }

    return this.repositories.inTransaction((unitOfWork) => {
      const root = unitOfWork.createMessage({ channelId: channel.id, senderType: 'system', authorName: 'Sinapsis', body: `任务「${input.title}」已创建。` })
      return createLabeledTask(unitOfWork, { ...taskInput, threadRootMessageId: root.id }, inferredLabels, input.labels !== undefined)
    })
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
    if (details.task.status !== 'needs_human') {
      throw new DomainError('Only tasks needing human handling can be requeued.')
    }
    return this.repositories.transitionTask(taskId, 'queued', '人工确认后重新进入任务队列')
  }

  async readArtifact(taskId: string, artifactId: string): Promise<{ kind: string; content: string }> {
    const artifact = this.repositories.getTaskArtifact(taskId, artifactId)
    if (!artifact) throw new NotFoundError(`Artifact ${artifactId} does not exist for task ${taskId}.`)
    return { kind: artifact.kind, content: await readFile(artifact.path, 'utf8') }
  }

  private requireRepository(repositoryId: string): void {
    findWorkspaceForRepository(this.repositories.getBootstrap().workspaces, repositoryId)
  }
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
