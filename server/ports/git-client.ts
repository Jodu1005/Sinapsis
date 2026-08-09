export interface RepositoryInspection {
  rootPath: string
  currentBranch: string
  defaultBranch: string
  isClean: boolean
}

export interface ChangedWorktreeFile {
  path: string
  status: 'added' | 'modified' | 'renamed'
}

export interface GitClient {
  inspectRepository(directory: string): Promise<RepositoryInspection>
  listChangedFiles?(directory: string): Promise<ChangedWorktreeFile[]>
}
