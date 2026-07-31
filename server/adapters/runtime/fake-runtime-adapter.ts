import type { RuntimeAvailability } from './runtime-profile'
import type { RuntimeAdapter, RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../../ports/runtime'

type RuntimeEventWithoutTaskId<T> = T extends { taskId: string } ? Omit<T, 'taskId'> : never

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly starts: RuntimeTaskRequest[] = []
  readonly inputs: Array<{ session: RuntimeSession; input: string }> = []
  readonly resumes: RuntimeSession[] = []
  readonly cancellations: RuntimeSession[] = []
  availability: RuntimeAvailability = { executable: 'available', taskExecution: 'unverified' }
  private readonly sinks = new Map<string, RuntimeEventSink>()

  detect(): Promise<RuntimeAvailability> {
    return Promise.resolve(this.availability)
  }

  async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.starts.push({ ...task, conversation: task.conversation ? { ...task.conversation } : undefined })
    this.sinks.set(task.taskId, sink)
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

  async resume(session: RuntimeSession, _sink: RuntimeEventSink): Promise<void> {
    this.resumes.push(session)
  }

  cancel(session: RuntimeSession): void {
    this.cancellations.push(session)
  }

  emit(taskId: string, event: RuntimeEventWithoutTaskId<import('../../ports/runtime').RuntimeEvent>): void {
    const sink = this.sinks.get(taskId)
    if (!sink) throw new Error(`No runtime sink for task ${taskId}.`)
    sink({ ...event, taskId } as import('../../ports/runtime').RuntimeEvent)
  }
}
