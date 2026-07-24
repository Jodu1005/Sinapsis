import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
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
})

class FakeResponse extends EventEmitter {
  readonly writeHead = vi.fn()
  readonly write = vi.fn()
  readonly end = vi.fn()
}
