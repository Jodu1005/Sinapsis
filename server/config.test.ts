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
      SINAPSIS_MAX_INITIAL_SPEAKERS: '2',
      SINAPSIS_MAX_CONVERSATION_ROUNDS: '3',
      SINAPSIS_MAX_HANDOFF_TARGETS_PER_REPLY: '1',
      SINAPSIS_PARTICIPATION_PROBE_TIMEOUT_MS: '1000',
      SINAPSIS_DUPLICATE_CHECK_TIMEOUT_MS: '2000',
      SINAPSIS_CONVERSATION_RESPONSE_TIMEOUT_MS: '3000',
    })).toMatchObject({
      maxParticipationCandidates: 4,
      maxInitialSpeakers: 2,
      maxConversationRounds: 3,
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

  it('rejects an initial speaker limit above two', () => {
    expect(() => getServiceConfig({ SINAPSIS_MAX_INITIAL_SPEAKERS: '3' }))
      .toThrow('SINAPSIS_MAX_INITIAL_SPEAKERS must be between 1 and 2.')
  })

  it('rejects a conversation round limit above three', () => {
    expect(() => getServiceConfig({ SINAPSIS_MAX_CONVERSATION_ROUNDS: '4' }))
      .toThrow('SINAPSIS_MAX_CONVERSATION_ROUNDS must be between 1 and 3.')
  })

  it('defaults Dream Runtime consolidation controls', () => {
    expect(getServiceConfig({})).toMatchObject({
      dreamRuntime: 'pi',
      dreamModel: '',
      dreamTimeoutMs: 120_000,
      maxDreamCandidatesPerRun: 20,
    })
  })

  it('parses and trims configured Dream Runtime consolidation controls', () => {
    expect(getServiceConfig({
      SINAPSIS_DREAM_RUNTIME: ' claude-code ',
      SINAPSIS_DREAM_MODEL: ' dream-model ',
      SINAPSIS_DREAM_TIMEOUT_MS: '45000',
      SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN: '50',
    })).toMatchObject({
      dreamRuntime: 'claude-code',
      dreamModel: 'dream-model',
      dreamTimeoutMs: 45_000,
      maxDreamCandidatesPerRun: 50,
    })
  })

  it('rejects an unsupported Dream Runtime', () => {
    expect(() => getServiceConfig({ SINAPSIS_DREAM_RUNTIME: 'unknown' }))
      .toThrow('SINAPSIS_DREAM_RUNTIME must be one of: opencode, pi, claude-code.')
  })

  it('requires Dream timeout to be a positive integer', () => {
    expect(() => getServiceConfig({ SINAPSIS_DREAM_TIMEOUT_MS: '0' }))
      .toThrow('SINAPSIS_DREAM_TIMEOUT_MS must be a positive integer.')
    expect(() => getServiceConfig({ SINAPSIS_DREAM_TIMEOUT_MS: '1.5' }))
      .toThrow('SINAPSIS_DREAM_TIMEOUT_MS must be a positive integer.')
  })

  it('requires the Dream candidate limit to be between one and fifty', () => {
    expect(() => getServiceConfig({ SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN: '0' }))
      .toThrow('SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN must be a positive integer.')
    expect(() => getServiceConfig({ SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN: '51' }))
      .toThrow('SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN must be between 1 and 50.')
  })
})
