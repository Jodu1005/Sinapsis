import { describe, expect, it } from 'vitest'
import { getChannelCapabilities, summitSystemKey } from './channel-policy'

describe('channel policy', () => {
  it('gives summit automatic membership and context reset capabilities', () => {
    expect(getChannelCapabilities(summitSystemKey)).toEqual({
      automaticAllAgents: true,
      resetContext: true,
      mutableMembership: false,
    })
  })

  it('gives ordinary channels mutable membership without summit capabilities', () => {
    expect(getChannelCapabilities(null)).toEqual({
      automaticAllAgents: false,
      resetContext: false,
      mutableMembership: true,
    })
  })
})
