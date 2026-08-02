export type MemoryScope = 'global' | 'channel'
export type MemoryKind = 'preference' | 'decision' | 'constraint' | 'fact' | 'workflow'
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'ignored' | 'superseded'
export type DreamRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DreamRun {
  id: string
  scope: 'channel'
  scopeId: string
  trigger: 'scheduled' | 'manual'
  status: DreamRunStatus
  fromMessageCreatedAt: string | null
  fromMessageId: string | null
  toMessageCreatedAt: string | null
  toMessageId: string | null
  candidateCount: number
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface MemoryCandidate {
  id: string
  dreamRunId: string
  proposedScope: MemoryScope
  channelId: string | null
  kind: MemoryKind
  proposedContent: string
  rationale: string
  confidence: number
  importance: number
  contentHash: string
  status: MemoryCandidateStatus
  reviewedContent: string | null
  reviewedScope: MemoryScope | null
  reviewedAt: string | null
  createdAt: string
}

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  channelId: string | null
  kind: MemoryKind
  content: string
  contentHash: string
  status: 'active' | 'archived'
  sourceCandidateId: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  sourceConfidence?: number
  sourceImportance?: number
}

export interface ThreadSummary {
  channelId: string
  threadRootMessageId: string
  content: string
  throughMessageCreatedAt: string | null
  throughMessageId: string | null
  createdAt: string
  updatedAt: string
}

export interface UpsertThreadSummaryInput {
  channelId: string
  threadRootMessageId: string
  content: string
  throughMessageCreatedAt: string
  throughMessageId: string
}

export interface DreamWatermark {
  channelId: string
  toMessageCreatedAt: string
  toMessageId: string
}

export interface CreateDreamRunInput {
  scope: 'channel'
  scopeId: string
  trigger: DreamRun['trigger']
  from: { createdAt: string; id: string } | null
  to: { createdAt: string; id: string } | null
}

export type DreamRunPatch = Partial<Pick<DreamRun, 'status' | 'candidateCount' | 'error' | 'startedAt' | 'completedAt'>>

export interface DreamRunFilter {
  channelId?: string
  status?: DreamRunStatus
}

export interface CreateMemoryCandidateInput {
  dreamRunId: string
  proposedScope: MemoryScope
  channelId: string | null
  kind: MemoryKind
  proposedContent: string
  rationale: string
  confidence: number
  importance: number
  sourceMessageIds: string[]
}

export interface MemoryCandidateFilter {
  dreamRunId?: string
  status?: MemoryCandidateStatus
  proposedScope?: MemoryScope
  channelId?: string
}

export interface ReviewMemoryCandidateInput {
  candidateId: string
  status: Extract<MemoryCandidateStatus, 'ignored' | 'superseded'>
  occurredAt: Date
}

export interface CreateMemoryFromCandidateInput {
  candidateId: string
  reviewedContent: string
  reviewedScope: MemoryScope
  occurredAt: Date
}
