import { spawn } from 'node:child_process'
import { ValidationError } from '../../application/workspace-service'
import {
  runtimeKinds,
  type RuntimeAvailability,
  type RuntimeAvailabilityDetector,
  type RuntimeKind,
  type RuntimeProfile,
} from '../../ports/runtime-profile'

export { runtimeKinds, type RuntimeAvailability, type RuntimeAvailabilityDetector, type RuntimeKind, type RuntimeProfile } from '../../ports/runtime-profile'

export type RuntimeProfileOverrides = Partial<Pick<RuntimeProfile, 'command' | 'args' | 'model' | 'env'>>

export const runtimePresets = {
  opencode: { command: 'opencode', args: ['run'], model: '', env: {}, policy: 'task-worktree' },
  pi: { command: 'pi', args: ['--mode', 'rpc'], model: '', env: {}, policy: 'task-worktree' },
  'claude-code': { command: 'claude', args: [], model: '', env: {}, policy: 'task-worktree' },
} as const

export function resolveRuntimeProfile(runtime: RuntimeKind, overrides: RuntimeProfileOverrides = {}): RuntimeProfile {
  const preset = runtimePresets[runtime]
  const additionalArgs = overrides.args ?? []
  validateAdditionalArgs(runtime, additionalArgs)
  return {
    runtime,
    command: overrides.command ?? preset.command,
    args: [...preset.args, ...additionalArgs],
    model: overrides.model ?? preset.model,
    env: overrides.env ?? { ...preset.env },
    policy: preset.policy,
  }
}

const openCodeSubcommands = new Set([
  'acp', 'agent', 'attach', 'completion', 'db', 'debug', 'export', 'github', 'import', 'mcp',
  'models', 'pr', 'providers', 'auth', 'run', 'serve', 'session', 'stats', 'uninstall', 'upgrade', 'web',
])

function validateAdditionalArgs(runtime: RuntimeKind, args: string[]): void {
  if (runtime === 'pi' && args.some((arg) => arg === '--mode' || arg.startsWith('--mode='))) {
    throw new ValidationError('Pi runtime arguments cannot override --mode rpc.')
  }
  if (runtime === 'opencode' && args.some((arg) => openCodeSubcommands.has(arg))) {
    throw new ValidationError('OpenCode runtime arguments cannot include command subcommands.')
  }
}

export class CommandRuntimeAvailabilityDetector implements RuntimeAvailabilityDetector {
  constructor(private readonly timeoutMs = 2_000) {}

  detect(profile: RuntimeProfile): Promise<RuntimeAvailability> {
    return new Promise((resolve) => {
      const child = spawn(profile.command, ['--version'], { shell: false, stdio: 'ignore' })
      let settled = false
      const finish = (availability: RuntimeAvailability) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(availability)
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish({ executable: 'available', taskExecution: 'unhealthy' })
      }, this.timeoutMs)

      child.once('error', (error: NodeJS.ErrnoException) => {
        finish(error.code === 'ENOENT'
          ? { executable: 'missing', taskExecution: 'unavailable' }
          : { executable: 'available', taskExecution: 'unhealthy' })
      })
      child.once('close', (code) => {
        finish(code === 0
          ? { executable: 'available', taskExecution: 'unverified' }
          : { executable: 'available', taskExecution: 'unhealthy' })
      })
    })
  }
}
