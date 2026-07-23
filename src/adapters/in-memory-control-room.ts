import type { ControlRoomSnapshot } from '../domain/control-room'
import type { ControlRoomStore } from '../ports/control-room-store'

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
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: ['src/api/rate-limit.ts'],
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

export function createInMemoryControlRoomStore(): ControlRoomStore {
  let snapshot = createInitialSnapshot()
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    replace: (nextSnapshot) => {
      snapshot = nextSnapshot
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
