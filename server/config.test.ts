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
})
