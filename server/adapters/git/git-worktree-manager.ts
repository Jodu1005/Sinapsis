import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeAllocation, WorktreeManager, WorktreeRequest } from '../../ports/worktree-manager'

const execFileAsync = promisify(execFile)

export interface GitWorktreeManagerOptions {
  dataDir: string
  repositoryRoots?: readonly string[]
}

export class GitWorktreeManager implements WorktreeManager {
  private readonly worktreesRoot: string
  private readonly repositoryRoots: readonly string[]

  constructor(options: GitWorktreeManagerOptions) {
    this.worktreesRoot = path.resolve(options.dataDir, 'worktrees')
    this.repositoryRoots = (options.repositoryRoots ?? []).map((repositoryRoot) => path.resolve(repositoryRoot))
  }

  async create(task: WorktreeRequest): Promise<WorktreeAllocation> {
    const repositoryRoot = await resolveExistingPath(task.repositoryRoot, 'Repository root')
    const worktreePath = path.resolve(
      this.worktreesRoot,
      pathSegment(task.repositoryId, 'repository ID'),
      pathSegment(task.id, 'task ID'),
    )
    assertInside(worktreePath, this.worktreesRoot, 'Worktree path must be inside the configured worktrees directory.')
    const resolvedWorktreesRoot = await resolvePathForCreation(this.worktreesRoot)
    let resolvedWorktreePath = await resolvePathForCreation(worktreePath)
    const protectedRoots = await Promise.all([repositoryRoot, ...this.repositoryRoots].map((root) => resolveExistingPath(root, 'Repository root')))

    assertOutsideProtectedRoots(resolvedWorktreePath, protectedRoots)
    assertInside(resolvedWorktreePath, resolvedWorktreesRoot, 'Worktree path must be inside the configured worktrees directory.')

    await assertMissing(worktreePath)
    await mkdir(path.dirname(worktreePath), { recursive: true })
    resolvedWorktreePath = await resolvePathForCreation(worktreePath)
    assertOutsideProtectedRoots(resolvedWorktreePath, protectedRoots)
    assertInside(resolvedWorktreePath, resolvedWorktreesRoot, 'Worktree path must be inside the configured worktrees directory.')

    const branchName = `sinapsis/task-${pathSegment(task.id, 'task ID')}`
    await execFileAsync('git', [
      '-C', repositoryRoot,
      'worktree', 'add', '-b', branchName, resolvedWorktreePath, requiredBranch(task.targetBranch),
    ], { shell: false })

    return { branchName, worktreePath }
  }
}

function pathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe path segment.`)
  }
  return value
}

function requiredBranch(value: string): string {
  if (!value.trim()) {
    throw new Error('Target branch is required.')
  }
  return value
}

async function assertMissing(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error(`Worktree path already exists: ${targetPath}`)
}

async function resolveExistingPath(targetPath: string, label: string): Promise<string> {
  try {
    return await realpath(path.resolve(targetPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist.`)
    }
    throw error
  }
}

async function resolvePathForCreation(targetPath: string): Promise<string> {
  let currentPath = path.resolve(targetPath)
  const missingSegments: string[] = []

  while (true) {
    try {
      return path.join(await realpath(currentPath), ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) {
        throw new Error(`Unable to resolve worktree path: ${targetPath}`)
      }
      missingSegments.unshift(path.basename(currentPath))
      currentPath = parentPath
    }
  }
}

function assertOutsideProtectedRoots(targetPath: string, protectedRoots: readonly string[]): void {
  for (const protectedRoot of protectedRoots) {
    if (isInside(targetPath, protectedRoot)) {
      throw new Error('Worktree path must not be inside the repository root.')
    }
  }
}

function assertInside(targetPath: string, parentPath: string, message: string): void {
  if (!isInside(targetPath, parentPath)) {
    throw new Error(message)
  }
}

function isInside(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
