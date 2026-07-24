export interface RepositoryInspection {
  rootPath: string
  currentBranch: string
  defaultBranch: string
  isClean: boolean
}

export interface GitClient {
  inspectRepository(directory: string): Promise<RepositoryInspection>
}
