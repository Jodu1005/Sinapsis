import { spawn } from 'node:child_process'
import type { ChangedWorktreeFile, GitClient, RepositoryInspection } from '../../ports/git-client'

export class CommandGitClient implements GitClient {
  async inspectRepository(directory: string): Promise<RepositoryInspection> {
    const rootPath = (await runGit(directory, ['rev-parse', '--show-toplevel'])).trim()
    const currentBranch = (await runGit(directory, ['symbolic-ref', '--short', 'HEAD'])).trim()
    const defaultBranch = await remoteDefaultBranch(rootPath, currentBranch)
    const status = await runGit(directory, ['status', '--porcelain=v1'])

    return { rootPath, currentBranch, defaultBranch, isClean: status.trim().length === 0 }
  }

  async listChangedFiles(directory: string): Promise<ChangedWorktreeFile[]> {
    const output = await runGit(directory, ['status', '--porcelain=v1', '--untracked-files=all', '-z'])
    const files = new Map<string, ChangedWorktreeFile>()
    const records = output.split('\0')
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      if (!record || record.length < 4) continue
      const status = record.slice(0, 2)
      const filePath = record.slice(3)
      if (!filePath || isDeletion(status)) continue
      if (isRenameOrCopy(status)) index += 1
      files.set(filePath, { path: filePath, status: statusForFile(status) })
    }
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  }
}

function isDeletion(status: string): boolean {
  return status.includes('D')
}

function isRenameOrCopy(status: string): boolean {
  return status.includes('R') || status.includes('C')
}

function statusForFile(status: string): ChangedWorktreeFile['status'] {
  if (isRenameOrCopy(status)) return 'renamed'
  if (status === '??' || status.includes('A')) return 'added'
  return 'modified'
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
