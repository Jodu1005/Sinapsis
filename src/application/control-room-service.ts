import type { Activity, ControlRoomSnapshot, EventKind, Task, TaskStatus } from '../domain/control-room'
import type { ControlRoomStore } from '../ports/control-room-store'

export function createControlRoomService(store: ControlRoomStore) {
  let sequence = 0

  function commit(taskId: string, status: TaskStatus, kind: EventKind, message: string) {
    const snapshot = store.getSnapshot()
    const at = new Date().toISOString()
    const entryId = `${taskId}-${at}-${++sequence}`
    const event = { id: entryId, kind, message, at }
    const activity: Activity = { id: `activity-${entryId}`, taskId, message, at }
    let changed = false
    const tasks = snapshot.tasks.map((task) => {
      if (task.id !== taskId) return task

      changed = true
      const nextTask: Task = {
        ...task,
        status,
        updatedAt: at,
        events: [...task.events, event],
      }
      return nextTask
    })

    if (!changed) return

    store.replace({ ...snapshot, tasks, activities: [activity, ...snapshot.activities] })
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
        commit(taskId, task.status, 'agent', 'Agent 正在整理本次工作总结')
      }
    },
    requestDecision(taskId: string) {
      if (getTask(taskId)?.status === 'running') {
        commit(taskId, 'needs_input', 'checkpoint', '请求人工决策：请确认是否继续覆盖旧版分支')
      }
    },
    sendFeedback(taskId: string, feedback: string) {
      const task = getTask(taskId)
      const trimmedFeedback = feedback.trim()
      if (trimmedFeedback && (task?.status === 'needs_input' || task?.status === 'in_review')) {
        commit(taskId, task.status, 'feedback', '人工反馈：' + trimmedFeedback)
      }
    },
    accept(taskId: string) {
      if (getTask(taskId)?.status === 'in_review') {
        commit(taskId, 'accepted', 'decision', '人工决定：已接受此改动')
      }
    },
    reject(taskId: string) {
      if (getTask(taskId)?.status === 'in_review') {
        commit(taskId, 'rejected', 'decision', '人工决定：已驳回此改动')
      }
    },
  }
}
