import type {
  Activity,
  ControlRoomSnapshot,
  ReviewDecision,
  SessionEvent,
  TaskStatus,
} from '../domain/control-room'
import type { ControlRoomStore, TaskEventCommand } from '../ports/control-room-store'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }

  return value
}

function createInitialSnapshot(): ControlRoomSnapshot {
  return {
    projectName: 'Sinapsis',
    branch: 'prototype-zero-control-room',
    agents: [
      { id: 'implementer', name: '实现者', role: '功能实现', runtime: 'Codex', state: 'active' },
      { id: 'architect', name: '测试者', role: '质量验证', runtime: 'Claude', state: 'waiting' },
      { id: 'reviewer', name: '审查者', role: '改动审查', runtime: 'Claude', state: 'reviewing' },
    ],
    tasks: [
      {
        id: 'refactor-auth',
        title: '重构身份验证中间件',
        ownerId: 'implementer',
        status: 'running',
        summary: '正在简化身份验证边界。',
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: ['src/auth/session.ts'],
      },
      {
        id: 'test-legacy-login',
        title: '验证旧版登录分支',
        ownerId: 'architect',
        status: 'needs_input',
        summary: '等待确认旧版登录覆盖范围。',
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: ['src/auth/legacy-login.test.ts'],
      },
      {
        id: 'review-rate-limit',
        title: '审查速率限制改动',
        ownerId: 'reviewer',
        status: 'in_review',
        summary: '速率限制改动已准备审查。',
        updatedAt: '2026-07-23T00:07:00.000Z',
        events: [
          {
            id: 'review-rate-limit-agent',
            kind: 'agent',
            message: '审查者已完成速率限制边界检查',
            at: '2026-07-23T00:05:00.000Z',
          },
          {
            id: 'review-rate-limit-artifact',
            kind: 'artifact',
            message: '已生成速率限制改动差异摘要',
            at: '2026-07-23T00:06:00.000Z',
          },
          {
            id: 'review-rate-limit-checkpoint',
            kind: 'checkpoint',
            message: '测试全部通过，等待人工审查决定',
            at: '2026-07-23T00:07:00.000Z',
          },
        ],
        changedFiles: ['src/api/rate-limit.ts'],
        diffSummary: '速率限制新增按调用方隔离的计数边界，并保留原有回退路径。',
        testOutput: '12 项速率限制测试通过',
      },
      {
        id: 'queue-observability',
        title: '补充队列可观测性',
        ownerId: 'implementer',
        status: 'todo',
        summary: '队列指标尚未开始补充。',
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: [],
      },
    ],
    activities: [],
  }
}

export function createInMemoryControlRoomStore(
  initialSnapshot: ControlRoomSnapshot = createInitialSnapshot(),
): ControlRoomStore {
  let snapshot = deepFreeze(initialSnapshot)
  const listeners = new Set<() => void>()

  function publishTaskUpdate(
    taskId: string,
    status: TaskStatus,
    event: SessionEvent,
    activity: Activity,
  ) {
    let changed = false
    const tasks = snapshot.tasks.map((task) => {
      if (task.id !== taskId) return task

      changed = true
      return {
        ...task,
        status,
        updatedAt: event.at,
        events: [...task.events, event],
      }
    })

    if (!changed) return

    snapshot = deepFreeze({
      ...snapshot,
      tasks,
      activities: [activity, ...snapshot.activities],
    })
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    appendTaskEvent(command: TaskEventCommand) {
      publishTaskUpdate(
        command.taskId,
        command.status,
        command.event,
        command.activity,
      )
    },
    recordReviewDecision(decision: ReviewDecision) {
      const event: SessionEvent = {
        id: decision.id,
        kind: 'decision',
        message: decision.message,
        at: decision.at,
      }
      const activity: Activity = {
        id: `activity-${decision.id}`,
        taskId: decision.taskId,
        message: decision.message,
        at: decision.at,
      }
      publishTaskUpdate(
        decision.taskId,
        decision.outcome,
        event,
        activity,
      )
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
