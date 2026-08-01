import type { Agent } from './agent'

export type RuntimeKind = Agent['runtime']

export type TurnMode = 'ordinary' | 'direct' | 'multi_direct' | 'all'

export type TurnStatus =
  | 'screening' | 'judging' | 'responding' | 'handoff'
  | 'completed' | 'partial' | 'cancelled' | 'failed'

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

export interface CreateConversationTurnInput {
  channelId: string
  triggerMessageId: string
  threadRootMessageId: string | null
  mode: TurnMode
  maxRounds: number
}

export type ConversationTurnPatch = Partial<Pick<
  ConversationTurn,
  'mode' | 'status' | 'currentRound' | 'maxRounds' | 'completedAt'
>>

export interface TurnParticipant {
  id: string
  turnId: string
  agentId: string
  source: 'responsibility' | 'direct' | 'all' | 'handoff'
  rank: number
  matcherScore: number | null
  decision: 'pending' | 'speak' | 'silent' | 'skipped'
  confidence: number | null
  proposedAngle: string | null
  dependsOnAgentId: string | null
  speakingOrder: number | null
  status: 'candidate' | 'selected' | 'spoken' | 'failed' | 'skipped' | 'cancelled'
  reason: string | null
  createdAt: string
  updatedAt: string
}

export type CreateTurnParticipantInput = Pick<
  TurnParticipant,
  'turnId' | 'agentId' | 'source' | 'rank' | 'matcherScore'
> & Partial<Pick<
  TurnParticipant,
  'decision' | 'confidence' | 'proposedAngle' | 'dependsOnAgentId' | 'speakingOrder' | 'status' | 'reason'
>>

export type ParticipantPatch = Partial<Pick<
  TurnParticipant,
  | 'source' | 'rank' | 'matcherScore' | 'decision' | 'confidence' | 'proposedAngle'
  | 'dependsOnAgentId' | 'speakingOrder' | 'status' | 'reason'
>>

export type InvocationKind =
  | 'participation' | 'response' | 'duplicate_check' | 'handoff_response'
export type InvocationStatus = 'queued' | 'running' | 'settled' | 'failed' | 'cancelled'
export type InvocationPriority =
  | 'human_direct' | 'human_ordinary' | 'participation'
  | 'duplicate_check' | 'automatic_handoff'

export interface AgentInvocation {
  id: string
  turnId: string
  agentId: string
  kind: InvocationKind
  priority: InvocationPriority
  round: number
  status: InvocationStatus
  idempotencyKey: string
  sourceInvocationId: string | null
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  errorCode: string | null
}

export type CreateAgentInvocationInput = Pick<
  AgentInvocation,
  'turnId' | 'agentId' | 'kind' | 'priority' | 'round' | 'idempotencyKey' | 'sourceInvocationId'
> & Partial<Pick<AgentInvocation, 'status' | 'startedAt' | 'completedAt' | 'errorCode'>>

export type InvocationPatch = Partial<Pick<
  AgentInvocation,
  'status' | 'startedAt' | 'completedAt' | 'errorCode'
>>

export interface ConversationHandoff {
  id: string
  turnId: string
  sourceInvocationId: string
  fromAgentId: string
  requestedTargetAgentId: string
  toAgentId: string | null
  question: string
  round: number
  status: 'queued' | 'accepted' | 'rejected' | 'completed' | 'failed'
  reason: string | null
  createdAt: string
  updatedAt: string
}

export type CreateConversationHandoffInput = Pick<
  ConversationHandoff,
  'turnId' | 'sourceInvocationId' | 'fromAgentId' | 'requestedTargetAgentId' | 'toAgentId' | 'question' | 'round'
> & Partial<Pick<ConversationHandoff, 'status' | 'reason'>>

export type ConversationHandoffPatch = Partial<Pick<ConversationHandoff, 'status' | 'reason'>>

export interface ConversationSession {
  id: string
  key: string
  channelId: string
  threadRootMessageId: string | null
  agentId: string
  runtime: RuntimeKind
  runtimeSessionId: string | null
  runtimeSessionFile: string | null
  status: 'ready' | 'active' | 'stale' | 'failed'
  lastMessageId: string | null
  lastUsedAt: string
  createdAt: string
  updatedAt: string
}

export type UpsertConversationSessionInput = Pick<
  ConversationSession,
  | 'key' | 'channelId' | 'threadRootMessageId' | 'agentId' | 'runtime'
  | 'runtimeSessionId' | 'runtimeSessionFile' | 'status' | 'lastMessageId'
>

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
