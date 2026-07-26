export interface Workspace {
  id: string
  name: string
  leaseTtlMs: number
  createdAt: string
}

export interface Repository {
  id: string
  workspaceId: string
  name: string
  path: string
  currentBranch: string
  defaultBranch: string
  isClean: boolean
  createdAt: string
}

export interface Channel {
  id: string
  repositoryId: string
  name: string
  archivedAt?: string | null
  subscriberAgentIds?: string[]
  createdAt: string
}

export interface CreateWorkspaceInput {
  name: string
  leaseTtlMs?: number
}

export interface CreateRepositoryInput {
  workspaceId: string
  name: string
  path: string
  currentBranch?: string
  defaultBranch?: string
  isClean?: boolean
}

export interface CreateChannelInput {
  repositoryId: string
  name: string
}
