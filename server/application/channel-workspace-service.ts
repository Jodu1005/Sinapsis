import { DomainError } from '../domain/task'
import type { Workspace } from '../domain/workspace'
import type { WorkspaceRepositories } from '../ports/repositories'
import { NotFoundError } from './workspace-service'

export class ChannelWorkspaceService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly maxWorkspaceBindingsPerChannel: number,
  ) {}

  list(channelId: string): Workspace[] {
    this.requireChannel(channelId)
    const workspaceIds = new Set(this.repositories.getChannelWorkspaceIds(channelId))
    return this.repositories.getBootstrap().workspaces
      .filter((workspace) => workspaceIds.has(workspace.id))
      .map(({ repositories: _repositories, ...workspace }) => workspace)
  }

  bind(channelId: string, workspaceId: string, actor: 'human'): Workspace[] {
    this.requireHuman(actor)
    this.requireChannel(channelId)
    this.requireWorkspace(workspaceId)
    const boundWorkspaceIds = this.repositories.getChannelWorkspaceIds(channelId)
    if (boundWorkspaceIds.includes(workspaceId)) return this.list(channelId)
    if (boundWorkspaceIds.length >= this.maxWorkspaceBindingsPerChannel) {
      throw new DomainError(`A channel can bind at most ${this.maxWorkspaceBindingsPerChannel} workspaces.`)
    }
    this.repositories.bindChannelWorkspace(channelId, workspaceId, new Date())
    return this.list(channelId)
  }

  unbind(channelId: string, workspaceId: string, actor: 'human'): Workspace[] {
    this.requireHuman(actor)
    this.requireChannel(channelId)
    this.requireWorkspace(workspaceId)
    if (!this.repositories.getChannelWorkspaceIds(channelId).includes(workspaceId)) return this.list(channelId)
    if (this.repositories.hasUnfinishedTask(channelId, workspaceId)) {
      throw new DomainError(`Workspace ${workspaceId} has an unfinished task in this channel.`)
    }
    this.repositories.unbindChannelWorkspace(channelId, workspaceId)
    return this.list(channelId)
  }

  private requireChannel(channelId: string): void {
    if (!this.repositories.getChannel(channelId)) throw new NotFoundError(`Channel ${channelId} does not exist.`)
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.repositories.getBootstrap().workspaces.find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} does not exist.`)
    const { repositories: _repositories, ...result } = workspace
    return result
  }

  private requireHuman(actor: 'human'): void {
    if (actor !== 'human') throw new DomainError('Only a human can manage channel workspace bindings.')
  }
}
