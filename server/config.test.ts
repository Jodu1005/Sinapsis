import { describe, expect, it } from 'vitest'
import { getServiceConfig } from './config'

describe('getServiceConfig', () => {
  it('defaults the per-channel workspace binding limit to five', () => {
    expect(getServiceConfig({})).toMatchObject({ maxWorkspaceBindingsPerChannel: 5 })
  })

  it('parses a configured per-channel workspace binding limit', () => {
    expect(getServiceConfig({ SINAPSIS_MAX_CHANNEL_WORKSPACES: '8' }))
      .toMatchObject({ maxWorkspaceBindingsPerChannel: 8 })
  })

  it('rejects a non-positive per-channel workspace binding limit', () => {
    expect(() => getServiceConfig({ SINAPSIS_MAX_CHANNEL_WORKSPACES: '0' }))
      .toThrow('SINAPSIS_MAX_CHANNEL_WORKSPACES must be a positive integer.')
  })

  it('defaults the conversation controls', () => {
    expect(getServiceConfig({})).toMatchObject({
      maxParticipationCandidates: 3,
      maxInitialSpeakers: 2,
      maxConversationRounds: 3,
      maxHandoffTargetsPerReply: 2,
      participationProbeTimeoutMs: 30_000,
      duplicateCheckTimeoutMs: 30_000,
      conversationResponseTimeoutMs: 90_000,
    })
  })

  it('parses configured conversation controls', () => {
    expect(getServiceConfig({
      SINAPSIS_MAX_PARTICIPATION_CANDIDATES: '4',
      SINAPSIS_MAX_INITIAL_SPEAKERS: '3',
      SINAPSIS_MAX_CONVERSATION_ROUNDS: '5',
      SINAPSIS_MAX_HANDOFF_TARGETS_PER_REPLY: '1',
      SINAPSIS_PARTICIPATION_PROBE_TIMEOUT_MS: '1000',
      SINAPSIS_DUPLICATE_CHECK_TIMEOUT_MS: '2000',
      SINAPSIS_CONVERSATION_RESPONSE_TIMEOUT_MS: '3000',
    })).toMatchObject({
      maxParticipationCandidates: 4,
      maxInitialSpeakers: 3,
      maxConversationRounds: 5,
      maxHandoffTargetsPerReply: 1,
      participationProbeTimeoutMs: 1000,
      duplicateCheckTimeoutMs: 2000,
      conversationResponseTimeoutMs: 3000,
    })
  })

  it('rejects a participation candidate limit outside the hard maximum', () => {
    expect(() => getServiceConfig({ SINAPSIS_MAX_PARTICIPATION_CANDIDATES: '6' }))
      .toThrow('SINAPSIS_MAX_PARTICIPATION_CANDIDATES must be between 1 and 5.')
  })
})
