import type { GitClient, RepositoryInspection } from '../ports/git-client'
import path from 'node:path'

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export interface WorkspaceCatalog {
  hasWorkspace(workspaceId: string): boolean
  hasRepository(repositoryId: string): boolean
  createWorkspace(input: { name: string }): { id: string; name: string; createdAt: string }
  createRepository(input: {
    workspaceId: string
    name: string
    path: string
    currentBranch: string
    defaultBranch: string
    isClean: boolean
  }): { id: string; workspaceId: string; name: string; path: string; currentBranch: string; defaultBranch: string; isClean: boolean; createdAt: string }
  createChannel(input: { repositoryId: string; name: string }): { id: string; repositoryId: string; name: string; createdAt: string }
}

export interface ManagedRepository {
  id: string
  workspaceId: string
  name: string
  path: string
  currentBranch: string
  defaultBranch: string
  isClean: boolean
  createdAt: string
}

export class WorkspaceService {
  constructor(
    private readonly catalog: WorkspaceCatalog,
    private readonly gitClient: GitClient,
  ) {}

  createWorkspace(input: { name: string }) {
    return this.catalog.createWorkspace({ name: requiredText(input.name, 'Workspace name') })
  }

  async addRepository(input: { workspaceId: string; directory: string; name?: string }): Promise<ManagedRepository> {
    if (!this.catalog.hasWorkspace(input.workspaceId)) {
      throw new NotFoundError(`Workspace ${input.workspaceId} does not exist.`)
    }

    let inspection: RepositoryInspection
    try {
      inspection = await this.gitClient.inspectRepository(requiredText(input.directory, 'Repository directory'))
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'Repository directory is not a Git repository.')
    }
    const repository = this.catalog.createRepository({
      workspaceId: input.workspaceId,
      name: input.name === undefined ? path.basename(inspection.rootPath) : requiredText(input.name, 'Repository name'),
      path: inspection.rootPath,
      currentBranch: inspection.currentBranch,
      defaultBranch: inspection.defaultBranch,
      isClean: inspection.isClean,
    })
    this.catalog.createChannel({ repositoryId: repository.id, name: 'general' })
    return toManagedRepository(repository, inspection)
  }

  createChannel(input: { repositoryId: string; name: string }) {
    if (!this.catalog.hasRepository(input.repositoryId)) {
      throw new NotFoundError(`Repository ${input.repositoryId} does not exist.`)
    }

    return this.catalog.createChannel({ repositoryId: input.repositoryId, name: requiredText(input.name, 'Channel name') })
  }
}

function toManagedRepository(
  repository: { id: string; workspaceId: string; name: string; path: string; currentBranch: string; defaultBranch: string; isClean: boolean; createdAt: string },
  inspection: RepositoryInspection,
): ManagedRepository {
  return { ...repository, currentBranch: inspection.currentBranch, defaultBranch: inspection.defaultBranch, isClean: inspection.isClean }
}

function requiredText(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new ValidationError(`${name} is required.`)
  return trimmed
}
