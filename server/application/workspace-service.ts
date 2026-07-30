import type { GitClient, RepositoryInspection } from '../ports/git-client'
import path from 'node:path'
import { DomainError } from '../domain/task'
import type { Channel } from '../domain/workspace'
import { summitSystemKey } from '../../shared/channel-policy'

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export interface WorkspaceMutationCatalog {
  createRepository(input: {
    workspaceId: string
    name: string
    path: string
    currentBranch: string
    defaultBranch: string
    isClean: boolean
  }): { id: string; workspaceId: string; name: string; path: string; currentBranch: string; defaultBranch: string; isClean: boolean; createdAt: string }
  createChannel(input: { name: string }): Channel
  ensureSystemChannel(input: { name: string; systemKey: string }): Channel
}

export interface WorkspaceCatalog {
  hasWorkspace(workspaceId: string): boolean
  createWorkspace(input: { name: string; leaseTtlMs?: number }): { id: string; name: string; leaseTtlMs: number; createdAt: string }
  inTransaction<T>(work: (catalog: WorkspaceMutationCatalog) => T): T
  createRepository: WorkspaceMutationCatalog['createRepository']
  createChannel: WorkspaceMutationCatalog['createChannel']
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

  createWorkspace(input: { name: string; leaseTtlMs?: number }) {
    return this.catalog.createWorkspace({
      name: requiredText(input.name, 'Workspace name'),
      leaseTtlMs: input.leaseTtlMs === undefined ? undefined : positiveInteger(input.leaseTtlMs, 'Workspace lease TTL'),
    })
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
    const repository = this.catalog.inTransaction((catalog) => {
      const repository = catalog.createRepository({
        workspaceId: input.workspaceId,
        name: input.name === undefined ? path.basename(inspection.rootPath) : requiredText(input.name, 'Repository name'),
        path: inspection.rootPath,
        currentBranch: inspection.currentBranch,
        defaultBranch: inspection.defaultBranch,
        isClean: inspection.isClean,
      })
      catalog.ensureSystemChannel({ name: summitSystemKey, systemKey: summitSystemKey })
      return repository
    })
    return toManagedRepository(repository, inspection)
  }

  createChannel(input: { name: string }) {
    const name = requiredText(input.name, 'Channel name')
    try {
      return this.catalog.createChannel({ name })
    } catch (error) {
      if (isChannelUniqueConstraint(error)) {
        throw new DomainError(`Channel #${name} already exists.`)
      }
      throw error
    }
  }
}

function isChannelUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new ValidationError(`${name} must be a positive integer.`)
  return value
}
