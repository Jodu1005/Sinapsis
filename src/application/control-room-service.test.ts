import { afterEach, vi } from 'vitest'

import { createInMemoryControlRoomStore } from '../adapters/in-memory-control-room'
import type {
  ControlRoomSnapshot,
  ReviewDecision,
  TaskStatus,
} from '../domain/control-room'
import type { ControlRoomStore } from '../ports/control-room-store'
import { createControlRoomService } from './control-room-service'

afterEach(() => {
  vi.useRealTimers()
})

function createSubject() {
  const store = createInMemoryControlRoomStore()
  return createControlRoomService(store)
}

function createSnapshotWithStatus(status: TaskStatus): ControlRoomSnapshot {
  const initial = createInMemoryControlRoomStore().getSnapshot()
  const sourceTask = initial.tasks[0]

  return {
    ...initial,
    tasks: [{
      ...sourceTask,
      id: 'matrix-task',
      status,
      events: [],
    }],
    activities: [],
  }
}

test('initial snapshot uses Chinese user-visible seat and task copy', () => {
  const snapshot = createSubject().getSnapshot()

  expect(snapshot.agents.map((agent) => agent.name)).toEqual(['实现者', '测试者', '审查者'])
  expect(snapshot.agents.map((agent) => agent.role)).toEqual(['功能实现', '质量验证', '改动审查'])
  expect(snapshot.tasks.map((task) => task.title)).toEqual([
    '重构身份验证中间件',
    '验证旧版登录分支',
    '审查速率限制改动',
    '补充队列可观测性',
  ])
  expect(snapshot.tasks.every((task) => !/[A-Za-z]/.test(task.summary))).toBe(true)
})

test('initial review task includes diff, tests, and typed chronology', () => {
  const snapshot = createInMemoryControlRoomStore().getSnapshot()
  const reviewTask = snapshot.tasks.find((task) => task.id === 'review-rate-limit')

  expect(reviewTask?.diffSummary).toContain('速率限制')
  expect(reviewTask?.testOutput).toContain('通过')
  expect(reviewTask?.events.map((event) => event.kind)).toEqual([
    'agent',
    'artifact',
    'checkpoint',
  ])
  expect(reviewTask?.events.every((event) => event.message.length > 0)).toBe(true)
  expect(reviewTask?.updatedAt).toBe(reviewTask?.events.at(-1)?.at)
})

test('accepting a review task records a decision and activity', () => {
  const service = createSubject()

  service.accept('review-rate-limit')

  const snapshot = service.getSnapshot()
  const task = snapshot.tasks.find((candidate) => candidate.id === 'review-rate-limit')!
  expect(task.status).toBe('accepted')
  expect(task.events.at(-1)).toMatchObject({
    kind: 'decision',
    message: '人工决定：已接受此改动',
  })
  expect(snapshot.activities.at(0)?.message).toContain('已接受')
})

test('review actions send typed decisions through the decision port', () => {
  const delegate = createInMemoryControlRoomStore()
  const decisions: ReviewDecision[] = []
  const recordingStore: ControlRoomStore = {
    getSnapshot: delegate.getSnapshot,
    appendTaskEvent: delegate.appendTaskEvent,
    recordReviewDecision(decision) {
      decisions.push(decision)
      delegate.recordReviewDecision(decision)
    },
    subscribe: delegate.subscribe,
  }
  const service = createControlRoomService(recordingStore)

  service.reject('review-rate-limit')

  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toMatchObject({
    taskId: 'review-rate-limit',
    outcome: 'rejected',
    message: '人工决定：已驳回此改动',
  })
})

test('requesting a decision moves only a running task to needs input', () => {
  const service = createSubject()

  service.requestDecision('refactor-auth')
  service.requestDecision('review-rate-limit')

  const snapshot = service.getSnapshot()
  const runningTask = snapshot.tasks.find((task) => task.id === 'refactor-auth')!
  expect(runningTask.status).toBe('needs_input')
  expect(runningTask.events.at(-1)).toMatchObject({
    kind: 'checkpoint',
    message: '请求人工决策：请确认是否继续覆盖旧版分支',
  })
  expect(snapshot.activities.at(0)).toMatchObject({
    taskId: 'refactor-auth',
    message: '请求人工决策：请确认是否继续覆盖旧版分支',
  })
  expect(snapshot.tasks.find((task) => task.id === 'review-rate-limit')?.status).toBe('in_review')
})

test('feedback resolves a needs-input task back to running', () => {
  const service = createSubject()

  service.requestDecision('refactor-auth')
  service.sendFeedback('refactor-auth', '继续覆盖旧版分支')

  const task = service.getSnapshot().tasks.find((candidate) => candidate.id === 'refactor-auth')!
  expect(task.status).toBe('running')
  expect(task.events.at(-1)).toMatchObject({
    kind: 'feedback',
    message: '人工反馈：继续覆盖旧版分支',
  })
})

test('requesting a summary records matching task and activity entries', () => {
  const service = createSubject()

  service.requestSummary('refactor-auth')

  const snapshot = service.getSnapshot()
  const task = snapshot.tasks.find((candidate) => candidate.id === 'refactor-auth')!
  expect(task.status).toBe('running')
  expect(task.events.at(-1)).toMatchObject({
    kind: 'agent',
    message: 'Agent 正在整理本次工作总结',
  })
  expect(snapshot.activities.at(0)).toMatchObject({
    taskId: 'refactor-auth',
    message: 'Agent 正在整理本次工作总结',
  })
})

test('rejecting a review task records a decision event and activity', () => {
  const service = createSubject()

  service.reject('review-rate-limit')

  const snapshot = service.getSnapshot()
  const task = snapshot.tasks.find((candidate) => candidate.id === 'review-rate-limit')!
  expect(task.status).toBe('rejected')
  expect(task.events.at(-1)).toMatchObject({
    kind: 'decision',
    message: '人工决定：已驳回此改动',
  })
  expect(snapshot.activities.at(0)?.message).toBe('人工决定：已驳回此改动')
})

test('non-empty feedback records unique task events and activities within one millisecond', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-23T12:00:00.000Z'))
  const service = createSubject()

  service.sendFeedback('review-rate-limit', '  请补充回归测试  ')
  service.sendFeedback('review-rate-limit', '确认兼容旧版分支')

  const snapshot = service.getSnapshot()
  const events = snapshot.tasks
    .find((task) => task.id === 'review-rate-limit')!
    .events.filter((event) => event.kind === 'feedback')
  expect(events.map((event) => event.message)).toEqual([
    '人工反馈：请补充回归测试',
    '人工反馈：确认兼容旧版分支',
  ])
  expect(new Set(events.map((event) => event.id)).size).toBe(2)
  expect(snapshot.activities.map((activity) => activity.message)).toEqual([
    '人工反馈：确认兼容旧版分支',
    '人工反馈：请补充回归测试',
  ])
  expect(new Set(snapshot.activities.map((activity) => activity.id)).size).toBe(2)
})

test('subscribers receive valid commits until they unsubscribe', () => {
  const service = createSubject()
  let notifications = 0
  const unsubscribe = service.subscribe(() => {
    notifications += 1
  })

  service.requestSummary('refactor-auth')
  unsubscribe()
  service.accept('review-rate-limit')

  expect(notifications).toBe(1)
})

test('invalid operations do not notify or add task events and activities', () => {
  const service = createSubject()
  let notifications = 0
  service.subscribe(() => {
    notifications += 1
  })
  const before = service.getSnapshot()
  const eventCount = before.tasks.reduce((total, task) => total + task.events.length, 0)

  service.sendFeedback('test-legacy-login', '   ')
  service.sendFeedback('refactor-auth', '运行中任务不能接收反馈')
  service.requestSummary('review-rate-limit')
  service.requestDecision('review-rate-limit')
  service.accept('refactor-auth')
  service.reject('refactor-auth')

  const after = service.getSnapshot()
  expect(notifications).toBe(0)
  expect(after.tasks.reduce((total, task) => total + task.events.length, 0)).toBe(eventCount)
  expect(after.activities).toHaveLength(before.activities.length)
})

test('snapshots stay referentially stable, deeply frozen, and preserve prior values', () => {
  const service = createSubject()
  const before = service.getSnapshot()

  expect(service.getSnapshot()).toBe(before)
  expect(Object.isFrozen(before)).toBe(true)
  expect(Object.isFrozen(before.tasks)).toBe(true)
  expect(Object.isFrozen(before.tasks[0])).toBe(true)
  expect(Object.isFrozen(before.tasks[0].events)).toBe(true)
  expect(() => {
    ;(before.tasks as unknown as Array<unknown>).push({})
  }).toThrow()

  const previousRunningTask = before.tasks.find((task) => task.id === 'refactor-auth')!
  service.requestSummary('refactor-auth')
  const after = service.getSnapshot()

  expect(after).not.toBe(before)
  expect(service.getSnapshot()).toBe(after)
  expect(previousRunningTask.events).toHaveLength(0)
  expect(before.activities).toHaveLength(0)
  expect(after.tasks.find((task) => task.id === 'refactor-auth')?.events).toHaveLength(1)
})

const taskStatuses: TaskStatus[] = [
  'todo',
  'running',
  'needs_input',
  'in_review',
  'accepted',
  'rejected',
]

const transitionCases = [
  {
    name: '请求总结',
    allowed: ['running'] as TaskStatus[],
    expectedStatus: (status: TaskStatus) => status,
    invoke: (service: ReturnType<typeof createControlRoomService>) => service.requestSummary('matrix-task'),
  },
  {
    name: '需要决策',
    allowed: ['running'] as TaskStatus[],
    expectedStatus: () => 'needs_input' as const,
    invoke: (service: ReturnType<typeof createControlRoomService>) => service.requestDecision('matrix-task'),
  },
  {
    name: '发送反馈',
    allowed: ['needs_input', 'in_review'] as TaskStatus[],
    expectedStatus: (status: TaskStatus) => status === 'needs_input' ? 'running' : status,
    invoke: (service: ReturnType<typeof createControlRoomService>) => (
      service.sendFeedback('matrix-task', '补充边界说明')
    ),
  },
  {
    name: '接受',
    allowed: ['in_review'] as TaskStatus[],
    expectedStatus: () => 'accepted' as const,
    invoke: (service: ReturnType<typeof createControlRoomService>) => service.accept('matrix-task'),
  },
  {
    name: '驳回',
    allowed: ['in_review'] as TaskStatus[],
    expectedStatus: () => 'rejected' as const,
    invoke: (service: ReturnType<typeof createControlRoomService>) => service.reject('matrix-task'),
  },
]

test.each(transitionCases)('$name obeys the full task-status transition matrix', ({ allowed, expectedStatus, invoke }) => {
  for (const status of taskStatuses) {
    const store = createInMemoryControlRoomStore(createSnapshotWithStatus(status))
    const service = createControlRoomService(store)
    const before = service.getSnapshot()

    invoke(service)

    const after = service.getSnapshot()
    const task = after.tasks[0]
    if (allowed.includes(status)) {
      expect(after).not.toBe(before)
      expect(task.status).toBe(expectedStatus(status))
      expect(task.events).toHaveLength(1)
      expect(after.activities).toHaveLength(1)
    } else {
      expect(after).toBe(before)
      expect(task.status).toBe(status)
      expect(task.events).toHaveLength(0)
      expect(after.activities).toHaveLength(0)
    }
  }
})
