import { describe, expect, it } from 'vitest'
import type { ConversationTurn } from '../domain/conversation'
import { HandoffPolicy, type HandoffValidationContext } from './handoff-policy'

describe('HandoffPolicy', () => {
  const policy = new HandoffPolicy()

  it.each([
    {
      name: 'rejects a target outside the channel',
      context: context({ channelMemberAgentIds: ['a1'] }),
      target: { agentId: 'outside', question: 'Please review.' },
      reason: 'target_not_channel_member',
    },
    {
      name: 'rejects a self handoff',
      context: context(),
      target: { agentId: 'a1', question: 'Please continue.' },
      reason: 'self_handoff',
    },
    {
      name: 'rejects an Agent that has already spoken',
      context: context({ spokenAgentIds: ['a3'] }),
      target: { agentId: 'a3', question: 'Please repeat.' },
      reason: 'agent_already_spoken',
    },
    {
      name: 'rejects a duplicate directed edge',
      context: context({ handoffEdges: [{ fromAgentId: 'a1', toAgentId: 'a2' }] }),
      target: { agentId: 'a2', question: 'Please review again.' },
      reason: 'duplicate_handoff_edge',
    },
    {
      name: 'rejects A -> B -> A',
      context: context({
        fromAgentId: 'a2',
        spokenAgentIds: [],
        handoffEdges: [{ fromAgentId: 'a1', toAgentId: 'a2' }],
      }),
      target: { agentId: 'a1', question: 'Please take it back.' },
      reason: 'handoff_cycle',
    },
    {
      name: 'rejects a fourth round',
      context: context({ turn: turn({ currentRound: 3, maxRounds: 3 }) }),
      target: { agentId: 'a2', question: 'Please continue.' },
      reason: 'max_rounds_reached',
    },
    {
      name: 'rejects an empty question',
      context: context(),
      target: { agentId: 'a2', question: '   ' },
      reason: 'question_required',
    },
  ])('$name', ({ context, target, reason }) => {
    expect(policy.validate([target], context)).toEqual({
      accepted: [],
      rejected: [{ agentId: target.agentId, reason }],
    })
  })

  it('accepts the first two valid targets and rejects a third target', () => {
    expect(policy.validate([
      { agentId: 'a2', question: 'Review the API.' },
      { agentId: 'a3', question: 'Review the tests.' },
      { agentId: 'a4', question: 'Review the release.' },
    ], context())).toEqual({
      accepted: [
        { agentId: 'a2', question: 'Review the API.' },
        { agentId: 'a3', question: 'Review the tests.' },
      ],
      rejected: [{ agentId: 'a4', reason: 'max_targets_exceeded' }],
    })
  })

  it('rejects a duplicate target within the same reply as a duplicate edge', () => {
    expect(policy.validate([
      { agentId: 'a2', question: 'Review the API.' },
      { agentId: 'a2', question: 'Review the API again.' },
    ], context())).toEqual({
      accepted: [{ agentId: 'a2', question: 'Review the API.' }],
      rejected: [{ agentId: 'a2', reason: 'duplicate_handoff_edge' }],
    })
  })
})

function context(overrides: Partial<HandoffValidationContext> = {}): HandoffValidationContext {
  return {
    turn: turn(),
    fromAgentId: 'a1',
    channelMemberAgentIds: ['a1', 'a2', 'a3', 'a4'],
    spokenAgentIds: ['a1'],
    handoffEdges: [],
    ...overrides,
  }
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1',
    channelId: 'channel-1',
    triggerMessageId: 'message-1',
    threadRootMessageId: null,
    mode: 'ordinary',
    status: 'handoff',
    currentRound: 1,
    maxRounds: 3,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}
