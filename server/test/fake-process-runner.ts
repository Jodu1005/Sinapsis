import type { ProcessHandle, ProcessRunner, SpawnProcessOptions } from '../ports/process-runner'

export class FakeProcessRunner implements ProcessRunner {
  readonly spawns: Array<{ options: SpawnProcessOptions; process: FakeProcessHandle }> = []

  spawn(options: SpawnProcessOptions): ProcessHandle {
    const process = new FakeProcessHandle()
    this.spawns.push({ options, process })
    return process
  }
}

export class FakeProcessHandle implements ProcessHandle {
  readonly stdin: string[] = []
  private readonly stdoutListeners: Array<(chunk: string) => void> = []
  private readonly stderrListeners: Array<(chunk: string) => void> = []
  private readonly errorListeners: Array<(error: Error) => void> = []
  private readonly exitListeners: Array<(result: { code: number | null; signal: NodeJS.Signals | null }) => void> = []

  write(value: string): void {
    this.stdin.push(value)
  }

  onStdout(listener: (chunk: string) => void): void {
    this.stdoutListeners.push(listener)
  }

  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener)
  }

  onExit(listener: (result: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.exitListeners.push(listener)
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener)
  }

  kill(): void {}

  emitStdout(chunk: string): void {
    this.stdoutListeners.forEach((listener) => listener(chunk))
  }

  emitStderr(chunk: string): void {
    this.stderrListeners.forEach((listener) => listener(chunk))
  }

  emitError(error: Error): void {
    this.errorListeners.forEach((listener) => listener(error))
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitListeners.forEach((listener) => listener({ code, signal }))
  }
}
