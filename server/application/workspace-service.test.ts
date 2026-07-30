import { describe, expect, it, vi } from 'vitest'
import type { GitClient } from '../ports/git-client'
import { DomainError } from '../domain/task'
import type { Channel } from '../domain/workspace'
import { WorkspaceService } from './workspace-service'

describe('WorkspaceService', () => {
  it('inspects a repository and atomically ensures the global summit channel', async () => {
    const gitClient = inspectingGitClient('/projects/sinapsis')
    const catalog = new RecordingWorkspaceCatalog('workspace-1')
    const service = new WorkspaceService(catalog, gitClient)

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
    expect(catalog.createdChannels).toEqual([{ name: 'summit', systemKey: 'summit' }])
    expect(catalog.systemChannels.get('summit')).toMatchObject({
      name: 'summit',
      systemKey: 'summit',
      memberAgentIds: [],
      boundWorkspaceIds: [],
    })
  })

  it('does not create a second summit channel for later repositories', async () => {
    const catalog = new RecordingWorkspaceCatalog('workspace-2', true)
    const service = new WorkspaceService(catalog, inspectingGitClient('/projects/workcode'))

    await service.addRepository({ workspaceId: 'workspace-2', directory: '/projects/workcode', name: 'WorkCode' })

    expect(catalog.createdChannels).toEqual([])
    expect(catalog.systemChannels.size).toBe(1)
  })

  it('rejects a directory that Git cannot inspect', async () => {
    const gitClient: GitClient = {
      inspectRepository: vi.fn().mockRejectedValue(new Error('Not a Git repository.')),
    }
    const service = new WorkspaceService(new RecordingWorkspaceCatalog('workspace-1'), gitClient)

    await expect(service.addRepository({ workspaceId: 'workspace-1', directory: '/tmp/not-a-repository', name: 'Scratch' }))
      .rejects.toThrow('Not a Git repository.')
  })

  it('rolls back repository creation when ensuring summit fails', async () => {
    const catalog = new TransactionalWorkspaceCatalog('workspace-1', true)
    const service = new WorkspaceService(catalog, inspectingGitClient('/projects/sinapsis'))

    await expect(service.addRepository({
      workspaceId: 'workspace-1',
      directory: '/projects/sinapsis',
      name: 'Sinapsis',
    })).rejects.toThrow('Channel insert failed.')

    expect(catalog.persistedRepositories).toEqual([])
    expect(catalog.persistedChannels).toEqual([])
  })

  it('creates a global ordinary channel without a repository locator', () => {
    const catalog = new RecordingWorkspaceCatalog('workspace-1')
    const service = new WorkspaceService(catalog, { inspectRepository: vi.fn() })

    const channel = service.createChannel({ name: 'release' })

    expect(channel).toMatchObject({
      name: 'release',
      systemKey: null,
      memberAgentIds: [],
      boundWorkspaceIds: [],
    })
    expect(channel).not.toHaveProperty('repositoryId')
  })

  it('maps a global channel uniqueness constraint to a domain conflict', () => {
    const service = new WorkspaceService(new DuplicateChannelCatalog('workspace-1'), { inspectRepository: vi.fn() })

    expect(() => service.createChannel({ name: 'general' }))
      .toThrow(new DomainError('Channel #general already exists.'))
  })
})

function inspectingGitClient(rootPath: string): GitClient & { inspectRepository: ReturnType<typeof vi.fn> } {
  return {
    inspectRepository: vi.fn().mockResolvedValue({
      rootPath,
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    }),
  }
}

class RecordingWorkspaceCatalog {
  readonly createdChannels: Array<{ name: string; systemKey?: string }> = []
  readonly systemChannels = new Map<string, Channel>()
  private repositoryNumber = 0

  constructor(private readonly workspaceId: string, hasSummit = false) {
    if (hasSummit) {
      this.systemChannels.set('summit', channel('channel-summit', 'summit', 'summit'))
    }
  }

  hasWorkspace(workspaceId: string): boolean {
    return workspaceId === this.workspaceId
  }

  createWorkspace(input: { name: string; leaseTtlMs?: number }) {
    return { id: this.workspaceId, name: input.name, leaseTtlMs: input.leaseTtlMs ?? 30_000, createdAt: '2026-07-25T00:00:00.000Z' }
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

  createChannel(input: { name: string }) {
    this.createdChannels.push(input)
    return channel(`channel-${this.createdChannels.length}`, input.name, null)
  }

  ensureSystemChannel(input: { name: string; systemKey: string }) {
    const existing = this.systemChannels.get(input.systemKey)
    if (existing) return existing
    this.createdChannels.push(input)
    const created = channel(`channel-${this.createdChannels.length}`, input.name, input.systemKey)
    this.systemChannels.set(input.systemKey, created)
    return created
  }
}

class TransactionalWorkspaceCatalog extends RecordingWorkspaceCatalog {
  readonly persistedRepositories: Array<{ id: string; workspaceId: string; name: string }> = []
  readonly persistedChannels: Channel[] = []

  constructor(workspaceId: string, private readonly failSystemChannel: boolean) {
    super(workspaceId)
  }

  override inTransaction<T>(work: (catalog: this) => T): T {
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

  override createRepository(input: Parameters<RecordingWorkspaceCatalog['createRepository']>[0]) {
    const repository = super.createRepository(input)
    this.persistedRepositories.push(repository)
    return repository
  }

  override ensureSystemChannel(input: { name: string; systemKey: string }) {
    if (this.failSystemChannel) throw new Error('Channel insert failed.')
    const created = super.ensureSystemChannel(input)
    this.persistedChannels.push(created)
    return created
  }
}

class DuplicateChannelCatalog extends RecordingWorkspaceCatalog {
  override createChannel(_input: { name: string }): never {
    throw new Error('UNIQUE constraint failed: channels.name')
  }
}

function channel(id: string, name: string, systemKey: string | null): Channel {
  return {
    id,
    name,
    systemKey,
    memberAgentIds: [],
    boundWorkspaceIds: [],
    createdAt: '2026-07-25T00:00:00.000Z',
  }
}
