import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { GitWorktreeManager } from './git-worktree-manager'
import { createGitFixture, type GitFixture } from '../../test/git-fixture'

describe('GitWorktreeManager', () => {
  let fixture: GitFixture | undefined

  afterEach(async () => {
    await fixture?.dispose()
    fixture = undefined
  })

  it('gives concurrent tasks distinct branches and worktree directories', async () => {
    fixture = await createGitFixture()
    const manager = new GitWorktreeManager({ dataDir: fixture.dataDir })

    const taskA = await manager.create({
      id: 'task-a', repositoryId: 'repository-1', repositoryRoot: fixture.repositoryRoot, targetBranch: 'main',
    })
    const taskB = await manager.create({
      id: 'task-b', repositoryId: 'repository-1', repositoryRoot: fixture.repositoryRoot, targetBranch: 'main',
    })

    expect(taskA).not.toEqual(taskB)
    expect(taskA.branchName).not.toBe(taskB.branchName)
    expect(taskA.worktreePath).toBe(`${fixture.dataDir}/worktrees/repository-1/task-a`)
    expect(taskB.worktreePath).toBe(`${fixture.dataDir}/worktrees/repository-1/task-b`)
    await expect(access(taskA.worktreePath)).resolves.toBeUndefined()
    await expect(access(taskB.worktreePath)).resolves.toBeUndefined()
  })

  it('refuses a worktree data directory located inside the source repository', async () => {
    fixture = await createGitFixture()
    const manager = new GitWorktreeManager({ dataDir: fixture.repositoryRoot })

    await expect(manager.create({
      id: 'task-a', repositoryId: 'repository-1', repositoryRoot: fixture.repositoryRoot, targetBranch: 'main',
    })).rejects.toThrow('must not be inside the repository root')
  })

  it('rejects an existing symlink ancestor that would place a worktree in the source repository', async () => {
    fixture = await createGitFixture()
    const worktreesDirectory = path.join(fixture.dataDir, 'worktrees')
    await mkdir(worktreesDirectory, { recursive: true })
    await symlink(fixture.repositoryRoot, path.join(worktreesDirectory, 'repository-1'))
    const manager = new GitWorktreeManager({ dataDir: fixture.dataDir })

    await expect(manager.create({
      id: 'task-a', repositoryId: 'repository-1', repositoryRoot: fixture.repositoryRoot, targetBranch: 'main',
    })).rejects.toThrow('inside the repository root')

    await expect(access(path.join(fixture.repositoryRoot, 'task-a'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
