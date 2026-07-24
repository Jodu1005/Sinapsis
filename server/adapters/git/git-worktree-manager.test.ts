import { afterEach, describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
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
})
