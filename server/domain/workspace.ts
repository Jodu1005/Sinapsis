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
  name: string
  systemKey: string | null
  memberAgentIds: string[]
  boundWorkspaceIds: string[]
  /** @deprecated Use memberAgentIds. */
  subscriberAgentIds?: string[]
  archivedAt?: string | null
  contextResetAt?: string | null
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
  name: string
  systemKey?: string | null
  /** @deprecated SQLite compatibility locator; ignored for global Channels. */
  repositoryId?: string
}
