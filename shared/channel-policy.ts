export const summitChannelName = 'summit'

export function canResetChannelContext(channelName: string): boolean {
  return channelName.trim().toLowerCase() === summitChannelName
}
