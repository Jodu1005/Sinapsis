export const summitChannelName = 'summit'
export const summitSystemKey = 'summit'

export interface ChannelCapabilities {
  automaticAllAgents: boolean
  resetContext: boolean
  mutableMembership: boolean
}

export function getChannelCapabilities(systemKey: string | null | undefined): ChannelCapabilities {
  const summit = systemKey === summitSystemKey
  return {
    automaticAllAgents: summit,
    resetContext: summit,
    mutableMembership: !summit,
  }
}

export function canResetChannelContext(channelName: string): boolean {
  return channelName.trim().toLowerCase() === summitChannelName
}
