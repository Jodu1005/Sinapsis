import type { DomainEvent } from '../domain/events'

export interface DomainEventPublisher {
  publish(event: DomainEvent): void
}
