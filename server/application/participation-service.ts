import {
  buildParticipationCall,
  parseParticipation,
  type ParticipationDecision,
  type RuntimeConversationCall,
} from './agent-conversation-protocol'

export interface ParticipationServiceOptions {
  participationProbeTimeoutMs: number
  invoke: (call: RuntimeConversationCall) => Promise<string>
}

export interface ParticipationDecisionInput {
  candidateAgentIds: string[]
  candidateResponsibilities: string[]
  currentMessage: string
  channelSummary: string
}

export type ParticipationResult = ParticipationDecision | { decision: 'silent'; reason: 'timeout' }

export class ParticipationService {
  private readonly participationProbeTimeoutMs: number
  private readonly invoke: (call: RuntimeConversationCall) => Promise<string>

  constructor(options: ParticipationServiceOptions) {
    this.participationProbeTimeoutMs = options.participationProbeTimeoutMs
    this.invoke = options.invoke
  }

  async decide(input: ParticipationDecisionInput): Promise<ParticipationResult> {
    const call = buildParticipationCall(input)
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.invoke(call).then((response) => parseParticipation(response, input.candidateAgentIds)),
        new Promise<ParticipationResult>((resolve) => {
          timeout = setTimeout(() => resolve({ decision: 'silent', reason: 'timeout' }), this.participationProbeTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
