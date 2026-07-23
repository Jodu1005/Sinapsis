import type { ControlRoomSnapshot } from '../domain/control-room'
import type { ControlRoomStore } from '../ports/control-room-store'

function createInitialSnapshot(): ControlRoomSnapshot {
  return {
    projectName: 'Sinapsis',
    branch: 'prototype-zero-control-room',
    agents: [
      { id: 'architect', name: 'Architect', role: 'Architecture', runtime: 'Claude', state: 'active' },
      { id: 'implementer', name: 'Implementer', role: 'Implementation', runtime: 'Codex', state: 'active' },
      { id: 'reviewer', name: 'Reviewer', role: 'Review', runtime: 'Claude', state: 'reviewing' },
    ],
    tasks: [
      {
        id: 'refactor-auth',
        title: 'Refactor authentication flow',
        ownerId: 'implementer',
        status: 'running',
        summary: 'Simplifying the authentication boundary.',
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: ['src/auth/session.ts'],
      },
      {
        id: 'test-legacy-login',
        title: 'Test legacy login',
        ownerId: 'architect',
        status: 'needs_input',
        summary: 'Waiting for feedback on legacy login coverage.',
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: ['src/auth/legacy-login.test.ts'],
      },
      {
        id: 'review-rate-limit',
        title: 'Review rate limiting',
        ownerId: 'reviewer',
        status: 'in_review',
        summary: 'Rate-limit changes are ready for review.',
        updatedAt: '2026-07-23T00:00:00.000Z',
        events: [],
        changedFiles: ['src/api/rate-limit.ts'],
      },
      {
        id: 'queue-observability',
        title: 'Add queue observability',
        ownerId: 'implementer',
        status: 'todo',
        summary: 'Queue metrics have not started.',
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
