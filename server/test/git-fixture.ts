import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GitFixture {
  directory: string
  repositoryRoot: string
  dataDir: string
  dispose(): Promise<void>
}

export async function createGitFixture(): Promise<GitFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sinapsis-worktree-'))
  const repositoryRoot = path.join(directory, 'repository')
  const dataDir = path.join(directory, 'data')
  await git(directory, ['init', '--initial-branch=main', repositoryRoot])
  await git(repositoryRoot, ['config', 'user.email', 'test@example.com'])
  await git(repositoryRoot, ['config', 'user.name', 'Sinapsis Test'])
  await writeFile(path.join(repositoryRoot, 'README.md'), 'fixture\n')
  await git(repositoryRoot, ['add', 'README.md'])
  await git(repositoryRoot, ['commit', '-m', 'initial fixture'])

  return {
    directory,
    repositoryRoot,
    dataDir,
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}
