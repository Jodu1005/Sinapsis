export const runtimeKinds = ['opencode', 'pi', 'claude-code'] as const
export type RuntimeKind = (typeof runtimeKinds)[number]

export interface RuntimeProfile {
  runtime: RuntimeKind
  command: string
  args: string[]
  model: string
  env: Record<string, string>
  policy: 'task-worktree'
}

export interface RuntimeAvailability {
  executable: 'available' | 'missing'
  taskExecution: 'unverified' | 'unhealthy' | 'unavailable'
}

export interface RuntimeAvailabilityDetector {
  detect(profile: RuntimeProfile): Promise<RuntimeAvailability>
}
