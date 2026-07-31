import type { Agent } from './agent'

export type TurnMode = 'ordinary' | 'direct' | 'multi_direct' | 'all'

export type TurnStatus =
  | 'screening' | 'judging' | 'responding' | 'handoff'
  | 'completed' | 'cancelled' | 'failed'

export interface ConversationTurn {
  id: string
  channelId: string
  triggerMessageId: string
  threadRootMessageId: string | null
  mode: TurnMode
  status: TurnStatus
  currentRound: number
  maxRounds: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface MentionRoute {
  mode: TurnMode
  targetAgentIds: string[]
  unknownMentions: string[]
}

export interface ResponsibilityCandidate {
  agent: Agent
  score: number
  matchedDescriptors: string[]
}
