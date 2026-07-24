import type { RuntimeAvailability } from './runtime-profile'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../../ports/runtime'

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly starts: RuntimeTaskRequest[] = []
  readonly inputs: Array<{ session: RuntimeSession; input: string }> = []
  availability: RuntimeAvailability = { executable: 'available', taskExecution: 'unverified' }

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve(this.availability)
  }

  async start(task: RuntimeTaskRequest, _sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.starts.push(task)
    return {
      taskId: task.taskId,
      runtime: task.profile.runtime,
      worktreePath: task.worktreePath,
      profile: task.profile,
      sessionId: null,
      sessionFile: null,
      isStreaming: false,
      queueLength: 0,
      pendingInputs: [],
    }
  }

  sendInput(session: RuntimeSession, input: string, _sink: RuntimeEventSink): void {
    this.inputs.push({ session, input })
  }

  async resume(_session: RuntimeSession, _sink: RuntimeEventSink): Promise<void> {}
}
