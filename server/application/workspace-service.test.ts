import { describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from './workspace-service'
import type { GitClient } from '../ports/git-client'

describe('WorkspaceService', () => {
  it('inspects a directory as a Git repository and creates its general channel', async () => {
    const gitClient: GitClient = {
      inspectRepository: vi.fn().mockResolvedValue({
        rootPath: '/projects/sinapsis',
        currentBranch: 'main',
        defaultBranch: 'main',
        isClean: true,
      }),
    }
    const repositories = new RecordingWorkspaceRepository('workspace-1')
    const service = new WorkspaceService(repositories, gitClient)

    const repository = await service.addRepository({
      workspaceId: 'workspace-1',
      directory: '/projects/sinapsis/packages/app',
      name: 'Sinapsis',
    })

    expect(gitClient.inspectRepository).toHaveBeenCalledWith('/projects/sinapsis/packages/app')
    expect(repository).toMatchObject({
      workspaceId: 'workspace-1',
      name: 'Sinapsis',
      path: '/projects/sinapsis',
      currentBranch: 'main',
      defaultBranch: 'main',
    })
    expect(repositories.createdChannels).toEqual([{ repositoryId: repository.id, name: 'general' }])
  })

  it('rejects a directory that Git cannot inspect', async () => {
    const gitClient: GitClient = {
      inspectRepository: vi.fn().mockRejectedValue(new Error('Not a Git repository.')),
    }
    const service = new WorkspaceService(new RecordingWorkspaceRepository('workspace-1'), gitClient)

    await expect(service.addRepository({ workspaceId: 'workspace-1', directory: '/tmp/not-a-repository', name: 'Scratch' }))
      .rejects.toThrow('Not a Git repository.')
  })

  it('rolls back repository creation when creating its general channel fails', async () => {
    const gitClient: GitClient = {
      inspectRepository: vi.fn().mockResolvedValue({
        rootPath: '/projects/sinapsis', currentBranch: 'feature/task-3', defaultBranch: 'main', isClean: true,
      }),
    }
    const repositories = new TransactionalWorkspaceRepository('workspace-1', true)
    const service = new WorkspaceService(repositories, gitClient)

    await expect(service.addRepository({
      workspaceId: 'workspace-1', directory: '/projects/sinapsis', name: 'Sinapsis',
    })).rejects.toThrow('Channel insert failed.')

    expect(repositories.persistedRepositories).toEqual([])
    expect(repositories.persistedChannels).toEqual([])
  })
})

class RecordingWorkspaceRepository {
  readonly createdChannels: Array<{ repositoryId: string; name: string }> = []
  private repositoryNumber = 0

  constructor(private readonly workspaceId: string) {}

  hasWorkspace(workspaceId: string): boolean {
    return workspaceId === this.workspaceId
  }

  hasRepository(_repositoryId: string): boolean {
    return false
  }

  createWorkspace(input: { name: string }) {
    return { id: this.workspaceId, ...input, createdAt: '2026-07-25T00:00:00.000Z' }
  }

  inTransaction<T>(work: (catalog: this) => T): T {
    return work(this)
  }

  createRepository(input: {
    workspaceId: string
    name: string
    path: string
    currentBranch: string
    defaultBranch: string
    isClean: boolean
  }) {
    this.repositoryNumber += 1
    return { id: `repository-${this.repositoryNumber}`, ...input, createdAt: '2026-07-25T00:00:00.000Z' }
  }

  createChannel(input: { repositoryId: string; name: string }) {
    this.createdChannels.push(input)
    return { id: `channel-${this.createdChannels.length}`, ...input, createdAt: '2026-07-25T00:00:00.000Z' }
  }
}

class TransactionalWorkspaceRepository extends RecordingWorkspaceRepository {
  readonly persistedRepositories: Array<{ id: string; workspaceId: string; name: string }> = []
  readonly persistedChannels: Array<{ repositoryId: string; name: string }> = []

  constructor(workspaceId: string, private readonly failGeneralChannel: boolean) {
    super(workspaceId)
  }

  inTransaction<T>(work: (catalog: this) => T): T {
    const repositorySnapshot = [...this.persistedRepositories]
    const channelSnapshot = [...this.persistedChannels]
    try {
      return work(this)
    } catch (error) {
      this.persistedRepositories.splice(0, this.persistedRepositories.length, ...repositorySnapshot)
      this.persistedChannels.splice(0, this.persistedChannels.length, ...channelSnapshot)
      throw error
    }
  }

  override createRepository(input: {
    workspaceId: string
    name: string
    path: string
    currentBranch: string
    defaultBranch: string
    isClean: boolean
  }) {
    const repository = super.createRepository(input)
    this.persistedRepositories.push(repository)
    return repository
  }

  override createChannel(input: { repositoryId: string; name: string }) {
    if (this.failGeneralChannel && input.name === 'general') {
      throw new Error('Channel insert failed.')
    }
    const channel = super.createChannel(input)
    this.persistedChannels.push(channel)
    return channel
  }
}
