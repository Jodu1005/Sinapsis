export interface WorktreeRequest {
  id: string
  repositoryId: string
  repositoryRoot: string
  targetBranch: string
}

export interface WorktreeAllocation {
  branchName: string
  worktreePath: string
}

export interface WorktreeManager {
  create(task: WorktreeRequest): Promise<WorktreeAllocation>
}
