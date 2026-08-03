import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { runtimeKinds, type RuntimeKind } from './adapters/runtime/runtime-profile'

export interface ServiceConfig {
  dataDir: string
  port: number
  maxWorkspaceBindingsPerChannel: number
  maxParticipationCandidates: number
  maxInitialSpeakers: number
  maxConversationRounds: number
  maxHandoffTargetsPerReply: number
  participationProbeTimeoutMs: number
  duplicateCheckTimeoutMs: number
  conversationResponseTimeoutMs: number
  dreamRuntime: RuntimeKind
  dreamModel: string
  dreamTimeoutMs: number
  maxDreamCandidatesPerRun: number
  dreamEnabled: boolean
  dreamTime: string
  dreamTimeZone: string
  dreamMaintenanceConcurrency: number
}

const defaultDataDir = path.join(homedir(), '.sinapsis')
const defaultPort = 4174
const defaultMaxWorkspaceBindingsPerChannel = 5
const defaultMaxParticipationCandidates = 3
const defaultMaxInitialSpeakers = 2
const defaultMaxConversationRounds = 3
const defaultMaxHandoffTargetsPerReply = 2
const defaultParticipationProbeTimeoutMs = 30_000
const defaultDuplicateCheckTimeoutMs = 30_000
const defaultConversationResponseTimeoutMs = 90_000
const defaultDreamRuntime: RuntimeKind = 'pi'
const defaultDreamTimeoutMs = 120_000
const defaultMaxDreamCandidatesPerRun = 20
const defaultDreamTime = '03:00'
const defaultDreamTimeZone = 'Asia/Shanghai'

export function getServiceConfig(environment = process.env): ServiceConfig {
  return {
    dataDir: environment.SINAPSIS_DATA_DIR?.trim() || defaultDataDir,
    port: parsePort(environment.SINAPSIS_PORT),
    maxWorkspaceBindingsPerChannel: parseMaxWorkspaceBindingsPerChannel(environment.SINAPSIS_MAX_CHANNEL_WORKSPACES),
    maxParticipationCandidates: parseBoundedPositiveInteger(
      environment.SINAPSIS_MAX_PARTICIPATION_CANDIDATES,
      defaultMaxParticipationCandidates,
      'SINAPSIS_MAX_PARTICIPATION_CANDIDATES',
      5,
    ),
    maxInitialSpeakers: parseBoundedPositiveInteger(
      environment.SINAPSIS_MAX_INITIAL_SPEAKERS,
      defaultMaxInitialSpeakers,
      'SINAPSIS_MAX_INITIAL_SPEAKERS',
      2,
    ),
    maxConversationRounds: parseBoundedPositiveInteger(
      environment.SINAPSIS_MAX_CONVERSATION_ROUNDS,
      defaultMaxConversationRounds,
      'SINAPSIS_MAX_CONVERSATION_ROUNDS',
      3,
    ),
    maxHandoffTargetsPerReply: parsePositiveInteger(environment.SINAPSIS_MAX_HANDOFF_TARGETS_PER_REPLY, defaultMaxHandoffTargetsPerReply, 'SINAPSIS_MAX_HANDOFF_TARGETS_PER_REPLY'),
    participationProbeTimeoutMs: parsePositiveInteger(environment.SINAPSIS_PARTICIPATION_PROBE_TIMEOUT_MS, defaultParticipationProbeTimeoutMs, 'SINAPSIS_PARTICIPATION_PROBE_TIMEOUT_MS'),
    duplicateCheckTimeoutMs: parsePositiveInteger(environment.SINAPSIS_DUPLICATE_CHECK_TIMEOUT_MS, defaultDuplicateCheckTimeoutMs, 'SINAPSIS_DUPLICATE_CHECK_TIMEOUT_MS'),
    conversationResponseTimeoutMs: parsePositiveInteger(environment.SINAPSIS_CONVERSATION_RESPONSE_TIMEOUT_MS, defaultConversationResponseTimeoutMs, 'SINAPSIS_CONVERSATION_RESPONSE_TIMEOUT_MS'),
    dreamRuntime: parseRuntimeKind(environment.SINAPSIS_DREAM_RUNTIME),
    dreamModel: environment.SINAPSIS_DREAM_MODEL?.trim() ?? '',
    dreamTimeoutMs: parsePositiveInteger(environment.SINAPSIS_DREAM_TIMEOUT_MS, defaultDreamTimeoutMs, 'SINAPSIS_DREAM_TIMEOUT_MS'),
    maxDreamCandidatesPerRun: parseBoundedPositiveInteger(
      environment.SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN,
      defaultMaxDreamCandidatesPerRun,
      'SINAPSIS_MAX_DREAM_CANDIDATES_PER_RUN',
      50,
    ),
    dreamEnabled: parseBoolean(environment.SINAPSIS_DREAM_ENABLED, true, 'SINAPSIS_DREAM_ENABLED'),
    dreamTime: parseTime(environment.SINAPSIS_DREAM_TIME, defaultDreamTime, 'SINAPSIS_DREAM_TIME'),
    dreamTimeZone: parseTimeZone(environment.SINAPSIS_DREAM_TIME_ZONE, defaultDreamTimeZone, 'SINAPSIS_DREAM_TIME_ZONE'),
    dreamMaintenanceConcurrency: parsePositiveInteger(
      environment.SINAPSIS_DREAM_MAINTENANCE_CONCURRENCY,
      1,
      'SINAPSIS_DREAM_MAINTENANCE_CONCURRENCY',
    ),
  }
}

export async function ensureDataDirectory(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return defaultPort
  }

  const port = Number(value)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SINAPSIS_PORT must be an integer between 1 and 65535.')
  }

  return port
}

function parseMaxWorkspaceBindingsPerChannel(value: string | undefined): number {
  if (!value) {
    return defaultMaxWorkspaceBindingsPerChannel
  }

  const limit = Number(value)

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('SINAPSIS_MAX_CHANNEL_WORKSPACES must be a positive integer.')
  }

  return limit
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, name: string): number {
  if (!value) return defaultValue

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

function parseBoundedPositiveInteger(value: string | undefined, defaultValue: number, name: string, maximum: number): number {
  const parsed = parsePositiveInteger(value, defaultValue, name)
  if (parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`)
  }
  return parsed
}

function parseRuntimeKind(value: string | undefined): RuntimeKind {
  const runtime = value?.trim() || defaultDreamRuntime
  if (!runtimeKinds.includes(runtime as RuntimeKind)) {
    throw new Error(`SINAPSIS_DREAM_RUNTIME must be one of: ${runtimeKinds.join(', ')}.`)
  }
  return runtime as RuntimeKind
}

function parseBoolean(value: string | undefined, defaultValue: boolean, name: string): boolean {
  if (value === undefined || !value.trim()) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${name} must be true or false.`)
}

function parseTime(value: string | undefined, defaultValue: string, name: string): string {
  const normalized = value?.trim() || defaultValue
  const match = /^(\d{2}):(\d{2})$/.exec(normalized)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${name} must use 24-hour HH:mm format.`)
  }
  return normalized
}

function parseTimeZone(value: string | undefined, defaultValue: string, name: string): string {
  const normalized = value?.trim() || defaultValue
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(0)
    return normalized
  } catch {
    throw new Error(`${name} must be a valid IANA time zone.`)
  }
}
