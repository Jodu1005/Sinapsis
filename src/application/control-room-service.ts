import type {
  Activity,
  EventKind,
  ReviewDecision,
  ReviewOutcome,
  TaskStatus,
} from '../domain/control-room'
import type { ControlRoomStore } from '../ports/control-room-store'

export function createControlRoomService(store: ControlRoomStore) {
  let sequence = 0

  function createEntry(taskId: string, message: string) {
    const at = new Date().toISOString()
    const entryId = `${taskId}-${at}-${++sequence}`
    const activity: Activity = { id: `activity-${entryId}`, taskId, message, at }
    return { at, entryId, activity }
  }

  function commitEvent(taskId: string, status: TaskStatus, kind: EventKind, message: string) {
    const { at, entryId, activity } = createEntry(taskId, message)
    store.appendTaskEvent({
      taskId,
      status,
      event: { id: entryId, kind, message, at },
      activity,
    })
  }

  function commitDecision(taskId: string, outcome: ReviewOutcome, message: string) {
    const { at, entryId } = createEntry(taskId, message)
    const decision: ReviewDecision = {
      id: entryId,
      taskId,
      outcome,
      message,
      at,
    }
    store.recordReviewDecision(decision)
  }

  function getTask(taskId: string) {
    return store.getSnapshot().tasks.find((task) => task.id === taskId)
  }

  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => store.subscribe(listener),
    requestSummary(taskId: string) {
      const task = getTask(taskId)
      if (task?.status === 'running') {
        commitEvent(taskId, task.status, 'agent', 'Agent 正在整理本次工作总结')
      }
    },
    requestDecision(taskId: string) {
      if (getTask(taskId)?.status === 'running') {
        commitEvent(taskId, 'needs_input', 'checkpoint', '请求人工决策：请确认是否继续覆盖旧版分支')
      }
    },
    sendFeedback(taskId: string, feedback: string) {
      const task = getTask(taskId)
      const trimmedFeedback = feedback.trim()
      if (trimmedFeedback && (task?.status === 'needs_input' || task?.status === 'in_review')) {
        commitEvent(taskId, task.status, 'feedback', '人工反馈：' + trimmedFeedback)
      }
    },
    accept(taskId: string) {
      if (getTask(taskId)?.status === 'in_review') {
        commitDecision(taskId, 'accepted', '人工决定：已接受此改动')
      }
    },
    reject(taskId: string) {
      if (getTask(taskId)?.status === 'in_review') {
        commitDecision(taskId, 'rejected', '人工决定：已驳回此改动')
      }
    },
  }
}
