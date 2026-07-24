import type { RuntimeAvailability, RuntimeAvailabilityDetector, RuntimeKind, RuntimeProfile } from '../adapters/runtime/runtime-profile'

export type RuntimeArtifactType = 'runtime-jsonl' | 'runtime-stderr' | 'runtime-exit'

export type RuntimeEvent =
  | { kind: 'artifact'; taskId: string; artifactType: RuntimeArtifactType; content: string }
  | { kind: 'text'; taskId: string; text: string }
  | { kind: 'tool_start'; taskId: string; toolName: string; toolCallId?: string }
  | { kind: 'tool_end'; taskId: string; toolName: string; toolCallId?: string; success?: boolean }
  | { kind: 'error'; taskId: string; message: string }
  | { kind: 'session'; taskId: string; sessionId: string; sessionFile?: string }
  | { kind: 'queue'; taskId: string; queueLength: number }
  | { kind: 'needs_input'; taskId: string; prompt: string }
  | { kind: 'settled'; taskId: string }

export type RuntimeEventSink = (event: RuntimeEvent) => void

export interface RuntimeTaskRequest {
  taskId: string
  title: string
  description: string
  acceptanceCriteria: string
  worktreePath: string
  profile: RuntimeProfile
}

export interface RuntimeSession {
  taskId: string
  runtime: RuntimeKind
  worktreePath: string
  profile: RuntimeProfile
  sessionId: string | null
  sessionFile: string | null
  isStreaming: boolean
  queueLength: number
  pendingInputs: string[]
}

export interface RuntimeAdapter extends RuntimeAvailabilityDetector {
  start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession>
  sendInput(session: RuntimeSession, input: string, sink: RuntimeEventSink): void
  resume(session: RuntimeSession, sink: RuntimeEventSink): Promise<void>
}

export type { RuntimeAvailability }
