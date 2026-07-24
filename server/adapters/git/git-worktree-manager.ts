import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
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
    const repositoryRoot = path.resolve(task.repositoryRoot)
    const worktreePath = path.resolve(this.worktreesRoot, pathSegment(task.repositoryId, 'repository ID'), pathSegment(task.id, 'task ID'))
    assertInside(worktreePath, this.worktreesRoot, 'Worktree path must be inside the configured worktrees directory.')

    for (const protectedRoot of [repositoryRoot, ...this.repositoryRoots]) {
      if (isInside(worktreePath, protectedRoot)) {
        throw new Error('Worktree path must not be inside the repository root.')
      }
    }

    await assertMissing(worktreePath)
    await mkdir(path.dirname(worktreePath), { recursive: true })

    const branchName = `sinapsis/task-${pathSegment(task.id, 'task ID')}`
    await execFileAsync('git', [
      '-C', repositoryRoot,
      'worktree', 'add', '-b', branchName, worktreePath, requiredBranch(task.targetBranch),
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
    await access(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error(`Worktree path already exists: ${targetPath}`)
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
