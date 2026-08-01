export const conversationEventTypes = [
  'conversation.turn_created',
  'conversation.turn_updated',
  'conversation.participant_updated',
  'conversation.invocation_updated',
  'conversation.handoff_created',
  'conversation.turn_completed',
] as const

export type ConversationEventType = (typeof conversationEventTypes)[number]

export interface DomainEvent {
  id: string
  type: string
  occurredAt: string
  entityType: string
  entityId: string
}
