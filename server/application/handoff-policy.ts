import type { ConversationTurn } from '../domain/conversation'

export interface HandoffValidationContext {
  turn: ConversationTurn
  fromAgentId: string
  channelMemberAgentIds: string[]
  spokenAgentIds: string[]
  handoffEdges: Array<{ fromAgentId: string; toAgentId: string }>
}

export interface HandoffDecision {
  accepted: Array<{ agentId: string; question: string }>
  rejected: Array<{ agentId: string; reason: string }>
}

const maxTargetsPerReply = 2

export class HandoffPolicy {
  validate(
    targets: Array<{ agentId: string; question: string }>,
    context: HandoffValidationContext,
  ): HandoffDecision {
    const accepted: HandoffDecision['accepted'] = []
    const rejected: HandoffDecision['rejected'] = []
    const handoffEdges = [...context.handoffEdges]

    targets.forEach((target, index) => {
      const reason = index >= maxTargetsPerReply
        ? 'max_targets_exceeded'
        : rejectionReason(target, { ...context, handoffEdges })
      if (reason) {
        rejected.push({ agentId: target.agentId, reason })
      } else {
        accepted.push(target)
        handoffEdges.push({ fromAgentId: context.fromAgentId, toAgentId: target.agentId })
      }
    })

    return { accepted, rejected }
  }
}

function rejectionReason(
  target: { agentId: string; question: string },
  context: HandoffValidationContext,
): string | null {
  if (context.turn.currentRound >= context.turn.maxRounds) return 'max_rounds_reached'
  if (!target.question.trim()) return 'question_required'
  if (!context.channelMemberAgentIds.includes(target.agentId)) return 'target_not_channel_member'
  if (target.agentId === context.fromAgentId) return 'self_handoff'
  if (context.handoffEdges.some((edge) => edge.fromAgentId === context.fromAgentId && edge.toAgentId === target.agentId)) {
    return 'duplicate_handoff_edge'
  }
  if (createsCycle(context.fromAgentId, target.agentId, context.handoffEdges)) return 'handoff_cycle'
  if (context.spokenAgentIds.includes(target.agentId)) return 'agent_already_spoken'
  return null
}

function createsCycle(
  fromAgentId: string,
  toAgentId: string,
  edges: Array<{ fromAgentId: string; toAgentId: string }>,
): boolean {
  const worklist = [toAgentId]
  const visited = new Set<string>()
  while (worklist.length > 0) {
    const agentId = worklist.pop()!
    if (agentId === fromAgentId) return true
    if (visited.has(agentId)) continue
    visited.add(agentId)
    for (const edge of edges) {
      if (edge.fromAgentId === agentId) worklist.push(edge.toAgentId)
    }
  }
  return false
}
