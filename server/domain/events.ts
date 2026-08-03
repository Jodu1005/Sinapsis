export const conversationEventTypes = [
  'conversation.turn_created',
  'conversation.turn_updated',
  'conversation.participant_updated',
  'conversation.invocation_updated',
  'conversation.handoff_created',
  'conversation.turn_completed',
] as const

export type ConversationEventType = (typeof conversationEventTypes)[number]

export const dreamEventTypes = [
  'dream.run_created',
  'dream.run_updated',
] as const

export const memoryEventTypes = [
  ...dreamEventTypes,
  'memory.candidate_created',
  'memory.candidate_reviewed',
  'memory.changed',
] as const

export type MemoryEventType = (typeof memoryEventTypes)[number]

export interface DomainEvent {
  id: string
  type: string
  occurredAt: string
  entityType: string
  entityId: string
}
