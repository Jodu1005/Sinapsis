export interface DomainEvent {
  id: string
  type: string
  occurredAt: string
  entityType: string
  entityId: string
}
