import type { RuntimeAvailability, RuntimeAvailabilityDetector, RuntimeKind, RuntimeProfile } from '../adapters/runtime/runtime-profile'
import type { InvocationKind } from '../domain/conversation'

export type RuntimeArtifactType = 'runtime-stdout' | 'runtime-jsonl' | 'runtime-stderr' | 'runtime-exit'
export type RuntimeErrorCode = 'session_lost' | 'timeout' | 'runtime_failure'

export type RuntimeEvent =
  | { kind: 'artifact'; taskId: string; artifactType: RuntimeArtifactType; content: string }
  | { kind: 'text'; taskId: string; text: string }
  | { kind: 'tool_start'; taskId: string; toolName: string; toolCallId?: string }
  | { kind: 'tool_end'; taskId: string; toolName: string; toolCallId?: string; success?: boolean }
  | { kind: 'error'; taskId: string; message: string; errorCode?: RuntimeErrorCode }
  | { kind: 'session'; taskId: string; sessionId: string; sessionFile?: string }
  | { kind: 'queue'; taskId: string; queueLength: number }
  | { kind: 'needs_input'; taskId: string; prompt: string }
  | { kind: 'settled'; taskId: string }

export type RuntimeEventSink = (event: RuntimeEvent) => void

export type RuntimeExecutionPolicy = 'default' | 'read-only-no-tools'

export interface RuntimeTaskRequest {
  taskId: string
  mode: 'task' | 'conversation'
  title: string
  description: string
  acceptanceCriteria: string
  initialMessage?: string
  worktreePath: string
  profile: RuntimeProfile
  executionPolicy?: RuntimeExecutionPolicy
  conversation?: {
    turnId: string
    invocationId: string
    kind: InvocationKind
    expectedOutput: 'participation' | 'public_response' | 'duplicate'
  }
}

export interface RuntimeSession {
  taskId: string
  runtime: RuntimeKind
  worktreePath: string
  profile: RuntimeProfile
  executionPolicy?: RuntimeExecutionPolicy
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
  cancel(session: RuntimeSession): void
}

export type { RuntimeAvailability }
