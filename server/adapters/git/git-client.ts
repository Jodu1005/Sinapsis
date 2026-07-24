import { spawn } from 'node:child_process'
import type { GitClient, RepositoryInspection } from '../../ports/git-client'

export class CommandGitClient implements GitClient {
  async inspectRepository(directory: string): Promise<RepositoryInspection> {
    const rootPath = (await runGit(directory, ['rev-parse', '--show-toplevel'])).trim()
    const currentBranch = (await runGit(directory, ['symbolic-ref', '--short', 'HEAD'])).trim()
    const defaultBranch = await remoteDefaultBranch(rootPath, currentBranch)
    const status = await runGit(directory, ['status', '--porcelain=v1'])

    return { rootPath, currentBranch, defaultBranch, isClean: status.trim().length === 0 }
  }
}

async function remoteDefaultBranch(rootPath: string, fallback: string): Promise<string> {
  try {
    const remoteReference = (await runGit(rootPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])).trim()
    if (remoteReference.startsWith('origin/')) {
      return remoteReference.slice('origin/'.length)
    }
  } catch {
    // A local clone may not have an origin/HEAD symbolic ref.
  }

  for (const branch of ['main', 'master']) {
    try {
      await runGit(rootPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      return branch
    } catch {
      // Try the next known default branch.
    }
  }

  return fallback
}

function runGit(directory: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', directory, ...args], { shell: false })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }

      const detail = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(detail || `Git exited with status ${code ?? 'unknown'}.`))
    })
  })
}
