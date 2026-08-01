import { describe, expect, it } from 'vitest'
import {
  buildParticipationCall,
  parseDuplicateDecision,
  parseParticipation,
  parsePublicResponse,
} from './agent-conversation-protocol'

describe('agent conversation protocol', () => {
  it('parses a valid participation decision for a candidate dependency', () => {
    expect(parseParticipation(
      '{"decision":"speak","confidence":0.8,"reason":"frontend responsibility","proposedAngle":"review the form","dependsOnAgentId":"a2"}',
      ['a1', 'a2'],
    )).toEqual({
      decision: 'speak',
      confidence: 0.8,
      reason: 'frontend responsibility',
      proposedAngle: 'review the form',
      dependsOnAgentId: 'a2',
    })
  })

  it('parses JSON fenced structured output', () => {
    expect(parseParticipation('```json\n{"decision":"silent","confidence":0,"reason":"not relevant","proposedAngle":"","dependsOnAgentId":null}\n```'))
      .toEqual({ decision: 'silent', confidence: 0, reason: 'not relevant', proposedAngle: '', dependsOnAgentId: null })
  })

  it('rejects invalid participation actions and unknown fields', () => {
    expect(() => parseParticipation('{"decision":"handoff"}')).toThrow()
    expect(() => parseParticipation('{"decision":"speak","confidence":0.8,"reason":"valid","proposedAngle":"valid","dependsOnAgentId":null,"extra":true}')).toThrow()
  })

  it('rejects participation values beyond their trust boundary', () => {
    expect(() => parseParticipation('{"decision":"speak","confidence":1.1,"reason":"valid","proposedAngle":"valid","dependsOnAgentId":null}')).toThrow()
    expect(() => parseParticipation(`{"decision":"speak","confidence":0.5,"reason":"${'r'.repeat(501)}","proposedAngle":"valid","dependsOnAgentId":null}`)).toThrow()
    expect(() => parseParticipation('{"decision":"speak","confidence":0.5,"reason":"valid","proposedAngle":"valid","dependsOnAgentId":"outside"}', ['a1'])).toThrow()
  })

  it('uses plain public text as a reply without inferring a handoff from an ordinary mention', () => {
    expect(parsePublicResponse('Could @reviewer take a look?')).toEqual({
      reply: 'Could @reviewer take a look?',
      handoffTo: [],
    })
  })

  it('parses policy-invalid Handoff candidates within the absolute protocol limit', () => {
    expect(parsePublicResponse('{"reply":"Complete","handoffTo":[{"agentId":"a2","question":""},{"agentId":"a3","question":"two"},{"agentId":"a4","question":"three"}]}'))
      .toEqual({
        reply: 'Complete',
        handoffTo: [
          { agentId: 'a2', question: '' },
          { agentId: 'a3', question: 'two' },
          { agentId: 'a4', question: 'three' },
        ],
      })
  })

  it('rejects unsafe structured public responses', () => {
    expect(() => parsePublicResponse('   ')).toThrow()
    expect(() => parsePublicResponse('x'.repeat(20_001))).toThrow()
    expect(() => parsePublicResponse('{"reply":"","handoffTo":[]}')).toThrow()
    expect(() => parsePublicResponse('{"reply":"Complete","handoffTo":[],"extra":true}')).toThrow()
    expect(() => parsePublicResponse(`{"reply":"${'x'.repeat(20_001)}","handoffTo":[]}`)).toThrow()
    const twentyOneTargets = Array.from({ length: 21 }, (_, index) => ({ agentId: `a${index}`, question: '' }))
    expect(() => parsePublicResponse(JSON.stringify({ reply: 'Complete', handoffTo: twentyOneTargets }))).toThrow()
  })

  it('parses and validates duplicate decisions', () => {
    expect(parseDuplicateDecision('{"decision":"speak","reason":"adds tests","revisedAngle":"cover errors"}'))
      .toEqual({ decision: 'speak', reason: 'adds tests', revisedAngle: 'cover errors' })
    expect(() => parseDuplicateDecision('{"decision":"silent","reason":"covered","revisedAngle":null,"extra":true}')).toThrow()
    expect(() => parseDuplicateDecision(`{"decision":"silent","reason":"covered","revisedAngle":"${'x'.repeat(501)}"}`)).toThrow()
  })

  it('builds a participation runtime call that constrains dependencies to valid candidate IDs', () => {
    const call = buildParticipationCall({
      candidateAgentIds: ['a1', 'a2'],
      candidateResponsibilities: ['frontend', 'forms'],
      currentMessage: 'The form does not submit.',
      channelSummary: 'User reported a checkout issue.',
    })

    expect(call.kind).toBe('participation')
    expect(call.initialMessage).toBe('The form does not submit.')
    expect(call.prompt).toContain('frontend')
    expect(call.prompt).toContain('User reported a checkout issue.')
    expect(call.prompt).toContain('a1')
    expect(call.prompt).toContain('a2')
    expect(call.prompt).toContain('dependsOnAgentId must be null or exactly one ID from this list')
  })
})
