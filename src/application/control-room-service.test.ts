import { createInMemoryControlRoomStore } from '../adapters/in-memory-control-room'
import { createControlRoomService } from './control-room-service'

function createSubject() {
  const store = createInMemoryControlRoomStore()
  return createControlRoomService(store)
}

test('accepting a review task records a decision and activity', () => {
  const service = createSubject()

  service.accept('review-rate-limit')

  const snapshot = service.getSnapshot()
  expect(snapshot.tasks.find((task) => task.id === 'review-rate-limit')?.status).toBe('accepted')
  expect(snapshot.activities.at(0)?.message).toContain('已接受')
})

test('requesting a decision moves only a running task to needs input', () => {
  const service = createSubject()

  service.requestDecision('refactor-auth')
  service.requestDecision('review-rate-limit')

  expect(service.getSnapshot().tasks.find((task) => task.id === 'refactor-auth')?.status).toBe('needs_input')
  expect(service.getSnapshot().tasks.find((task) => task.id === 'review-rate-limit')?.status).toBe('in_review')
})

test('empty feedback does not create a timeline event', () => {
  const service = createSubject()
  const before = service.getSnapshot().tasks.find((task) => task.id === 'test-legacy-login')!.events.length

  service.sendFeedback('test-legacy-login', '   ')

  expect(service.getSnapshot().tasks.find((task) => task.id === 'test-legacy-login')!.events).toHaveLength(before)
})
