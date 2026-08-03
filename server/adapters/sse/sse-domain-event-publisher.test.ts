import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { conversationEventTypes, memoryEventTypes } from '../../domain/events'
import { SseDomainEventPublisher } from './sse-domain-event-publisher'

describe('SseDomainEventPublisher', () => {
  it('ends and forgets connected clients when the local service shuts down', () => {
    const publisher = new SseDomainEventPublisher()
    const response = new FakeResponse()
    publisher.handle({} as never, response as never)

    publisher.close()

    expect(response.end).toHaveBeenCalledOnce()
    publisher.publish({ id: 'event-1', type: 'task.claimed', occurredAt: '2026-07-25T00:00:00.000Z', entityType: 'task', entityId: 'task-1' })
    expect(response.write).toHaveBeenCalledOnce()
  })

  it('publishes every public conversation lifecycle event as a named SSE event', () => {
    const publisher = new SseDomainEventPublisher()
    const response = new FakeResponse()
    publisher.handle({} as never, response as never)

    conversationEventTypes.forEach((type, index) => publisher.publish({
      id: `event-${index}`,
      type,
      occurredAt: '2026-07-31T08:00:00.000Z',
      entityType: 'conversation_turn',
      entityId: 'turn-1',
    }))

    const payloads = response.write.mock.calls.slice(1).map(([payload]) => String(payload))
    expect(payloads).toHaveLength(conversationEventTypes.length)
    for (const type of conversationEventTypes) {
      expect(payloads.some((payload) => payload.includes(`event: ${type}\n`))).toBe(true)
    }
  })

  it('publishes every Dream and Memory lifecycle event as a named SSE event without content payloads', () => {
    const publisher = new SseDomainEventPublisher()
    const response = new FakeResponse()
    publisher.handle({} as never, response as never)

    memoryEventTypes.forEach((type, index) => publisher.publish({
      id: `memory-event-${index}`, type, occurredAt: '2026-08-03T08:00:00.000Z',
      entityType: type.startsWith('dream.') ? 'dream_run' : 'memory', entityId: 'memory-1',
    }))

    const payloads = response.write.mock.calls.slice(1).map(([payload]) => String(payload))
    expect(payloads).toHaveLength(memoryEventTypes.length)
    expect(payloads.join('')).not.toMatch(/proposedContent|reviewedContent|runtime|prompt|artifact/i)
    for (const type of memoryEventTypes) expect(payloads.some((payload) => payload.includes(`event: ${type}\n`))).toBe(true)
  })
})

class FakeResponse extends EventEmitter {
  readonly writeHead = vi.fn()
  readonly write = vi.fn()
  readonly end = vi.fn()
}
