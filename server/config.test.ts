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

  it('defaults Dream scheduling controls', () => {
    expect(getServiceConfig({})).toMatchObject({
      dreamEnabled: true,
      dreamTime: '03:00',
      dreamTimeZone: 'Asia/Shanghai',
      dreamMaintenanceConcurrency: 1,
    })
  })

  it('parses configured Dream scheduling controls', () => {
    expect(getServiceConfig({
      SINAPSIS_DREAM_ENABLED: 'false',
      SINAPSIS_DREAM_TIME: '22:45',
      SINAPSIS_DREAM_TIME_ZONE: 'America/New_York',
      SINAPSIS_DREAM_MAINTENANCE_CONCURRENCY: '3',
    })).toMatchObject({
      dreamEnabled: false,
      dreamTime: '22:45',
      dreamTimeZone: 'America/New_York',
      dreamMaintenanceConcurrency: 3,
    })
  })

  it('rejects invalid Dream scheduling controls', () => {
    expect(() => getServiceConfig({ SINAPSIS_DREAM_ENABLED: 'sometimes' }))
      .toThrow('SINAPSIS_DREAM_ENABLED must be true or false.')
    expect(() => getServiceConfig({ SINAPSIS_DREAM_TIME: '24:00' }))
      .toThrow('SINAPSIS_DREAM_TIME must use 24-hour HH:mm format.')
    expect(() => getServiceConfig({ SINAPSIS_DREAM_TIME_ZONE: 'Mars/Olympus' }))
      .toThrow('SINAPSIS_DREAM_TIME_ZONE must be a valid IANA time zone.')
    expect(() => getServiceConfig({ SINAPSIS_DREAM_MAINTENANCE_CONCURRENCY: '0' }))
      .toThrow('SINAPSIS_DREAM_MAINTENANCE_CONCURRENCY must be a positive integer.')
  })
})
