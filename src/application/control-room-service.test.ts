import { afterEach, vi } from 'vitest'

import { createInMemoryControlRoomStore } from '../adapters/in-memory-control-room'
import { createControlRoomService } from './control-room-service'

afterEach(() => {
  vi.useRealTimers()
})

function createSubject() {
  const store = createInMemoryControlRoomStore()
  return createControlRoomService(store)
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

  service.sendFeedback('test-legacy-login', '  请补充回归测试  ')
  service.sendFeedback('test-legacy-login', '确认兼容旧版分支')

  const snapshot = service.getSnapshot()
  const events = snapshot.tasks.find((task) => task.id === 'test-legacy-login')!.events
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
