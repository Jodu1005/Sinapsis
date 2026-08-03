import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DomainEvent } from '../../domain/events'
import type { DomainEventPublisher } from '../../ports/domain-event-publisher'

export class SseDomainEventPublisher implements DomainEventPublisher {
  private readonly clients = new Set<ServerResponse>()

  handle(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.write(': connected\n\n')
    this.clients.add(response)
    response.on('close', () => this.clients.delete(response))
  }

  publish(event: DomainEvent): void {
    const payload = JSON.stringify(publicDomainEvent(event))
    for (const client of this.clients) {
      client.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${payload}\n\n`)
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.end()
    }
    this.clients.clear()
  }
}

function publicDomainEvent(event: DomainEvent): DomainEvent {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    entityType: event.entityType,
    entityId: event.entityId,
  }
}
