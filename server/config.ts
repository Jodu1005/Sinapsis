import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export interface ServiceConfig {
  dataDir: string
  port: number
  maxWorkspaceBindingsPerChannel: number
}

const defaultDataDir = path.join(homedir(), '.sinapsis')
const defaultPort = 4174
const defaultMaxWorkspaceBindingsPerChannel = 5

export function getServiceConfig(environment = process.env): ServiceConfig {
  return {
    dataDir: environment.SINAPSIS_DATA_DIR?.trim() || defaultDataDir,
    port: parsePort(environment.SINAPSIS_PORT),
    maxWorkspaceBindingsPerChannel: parseMaxWorkspaceBindingsPerChannel(environment.SINAPSIS_MAX_CHANNEL_WORKSPACES),
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
