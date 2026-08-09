import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CommandGitClient } from './git-client'

const execFileAsync = promisify(execFile)

describe('CommandGitClient', () => {
  it('uses the remote default branch when the current checkout is a feature branch', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sinapsis-git-client-'))
    const origin = path.join(directory, 'origin.git')
    const checkout = path.join(directory, 'checkout')
    await git(directory, ['init', '--bare', '--initial-branch=main', origin])
    await git(directory, ['clone', origin, checkout])
    await git(checkout, ['config', 'user.email', 'test@example.com'])
    await git(checkout, ['config', 'user.name', 'Test User'])
    await writeFile(path.join(checkout, 'README.md'), 'fixture\n')
    await git(checkout, ['add', 'README.md'])
    await git(checkout, ['commit', '-m', 'initial'])
    await git(checkout, ['push', 'origin', 'main'])
    await git(checkout, ['fetch', 'origin'])
    await git(checkout, ['remote', 'set-head', 'origin', '--auto'])
    await git(checkout, ['switch', '-c', 'feature/task-3'])

    await expect(new CommandGitClient().inspectRepository(checkout)).resolves.toMatchObject({
      currentBranch: 'feature/task-3', defaultBranch: 'main',
    })
  })

  it('uses local main when origin HEAD is unavailable from a feature checkout', async () => {
    const checkout = await createFeatureCheckout('main')
    await git(checkout, ['update-ref', '-d', 'refs/remotes/origin/HEAD'])

    await expect(new CommandGitClient().inspectRepository(checkout)).resolves.toMatchObject({
      currentBranch: 'feature/task-3', defaultBranch: 'main',
    })
  })

  it('uses local master when origin HEAD and local main are unavailable', async () => {
    const checkout = await createFeatureCheckout('master')
    await git(checkout, ['update-ref', '-d', 'refs/remotes/origin/HEAD'])

    await expect(new CommandGitClient().inspectRepository(checkout)).resolves.toMatchObject({
      currentBranch: 'feature/task-3', defaultBranch: 'master',
    })
  })

  it('uses the current branch only when origin HEAD, main, and master are unavailable', async () => {
    const checkout = await createFeatureCheckout('develop')
    await git(checkout, ['update-ref', '-d', 'refs/remotes/origin/HEAD'])

    await expect(new CommandGitClient().inspectRepository(checkout)).resolves.toMatchObject({
      currentBranch: 'feature/task-3', defaultBranch: 'feature/task-3',
    })
  })

  it('lists modified and untracked files in a task worktree', async () => {
    const checkout = await createFeatureCheckout('main')
    await writeFile(path.join(checkout, 'README.md'), 'changed\n')
    await writeFile(path.join(checkout, 'docs-output.md'), '# Deliverable\n')

    await expect(new CommandGitClient().listChangedFiles(checkout)).resolves.toEqual([
      { path: 'docs-output.md', status: 'added' },
      { path: 'README.md', status: 'modified' },
    ])
  })
})

async function createFeatureCheckout(initialBranch: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sinapsis-git-client-'))
  const origin = path.join(directory, 'origin.git')
  const checkout = path.join(directory, 'checkout')
  await git(directory, ['init', '--bare', `--initial-branch=${initialBranch}`, origin])
  await git(directory, ['clone', origin, checkout])
  await git(checkout, ['config', 'user.email', 'test@example.com'])
  await git(checkout, ['config', 'user.name', 'Test User'])
  await writeFile(path.join(checkout, 'README.md'), 'fixture\n')
  await git(checkout, ['add', 'README.md'])
  await git(checkout, ['commit', '-m', 'initial'])
  await git(checkout, ['push', 'origin', initialBranch])
  await git(checkout, ['fetch', 'origin'])
  await git(checkout, ['switch', '-c', 'feature/task-3'])
  return checkout
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}
