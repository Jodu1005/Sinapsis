import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface SpawnProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
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

export class NodeProcessRunner implements ProcessRunner {
  spawn(options: SpawnProcessOptions): ProcessHandle {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return new NodeProcessHandle(child)
  }
}

class NodeProcessHandle implements ProcessHandle {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  write(value: string): void {
    this.child.stdin.write(value)
  }

  onStdout(listener: (chunk: string) => void): void {
    this.child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString()))
  }

  onStderr(listener: (chunk: string) => void): void {
    this.child.stderr.on('data', (chunk: Buffer) => listener(chunk.toString()))
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
