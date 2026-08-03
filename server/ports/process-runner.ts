import { spawn, type ChildProcess } from 'node:child_process'

export interface SpawnProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdinMode?: 'pipe' | 'ignore'
}

export interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface ProcessHandle {
  write(value: string): void
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  onError(listener: (error: Error) => void): void
  onExit(listener: (result: ProcessExit) => void): void
  kill(): void
}

export interface ProcessRunner {
  spawn(options: SpawnProcessOptions): ProcessHandle
}

const inheritedEnvironmentKeys = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'TZ'] as const

export function buildProcessEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  profileEnvironment: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of inheritedEnvironmentKeys) {
    const value = inheritedEnvironment[key]
    if (value !== undefined) environment[key] = value
  }

  return {
    ...environment,
    ...profileEnvironment,
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_VALUE_0: '',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export class NodeProcessRunner implements ProcessRunner {
  spawn(options: SpawnProcessOptions): ProcessHandle {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: buildProcessEnvironment(process.env, options.env),
      shell: false,
      stdio: [options.stdinMode ?? 'pipe', 'pipe', 'pipe'],
    })
    return new NodeProcessHandle(child)
  }
}

class NodeProcessHandle implements ProcessHandle {
  constructor(private readonly child: ChildProcess) {}

  write(value: string): void {
    this.child.stdin?.write(value)
  }

  onStdout(listener: (chunk: string) => void): void {
    this.child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString()))
  }

  onStderr(listener: (chunk: string) => void): void {
    this.child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString()))
  }

  onError(listener: (error: Error) => void): void {
    this.child.once('error', listener)
  }

  onExit(listener: (result: ProcessExit) => void): void {
    this.child.once('close', (code, signal) => listener({ code, signal }))
  }

  kill(): void {
    this.child.kill()
  }
}
