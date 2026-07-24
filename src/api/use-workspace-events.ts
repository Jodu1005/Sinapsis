import { useEffect, useState } from 'react'

const refreshEvents = ['workspace.changed', 'repository.changed', 'channel.changed', 'message.changed', 'task.changed', 'agent.changed']

export function useWorkspaceEvents(refresh: () => void): boolean {
  const [reconnecting, setReconnecting] = useState(false)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined
    const source = new EventSource('/events')
    const onChange = () => { setReconnecting(false); refresh() }
    const onError = () => setReconnecting(true)
    const onOpen = () => { setReconnecting(false); void refresh() }
    refreshEvents.forEach((event) => source.addEventListener(event, onChange))
    source.onerror = onError
    source.onopen = onOpen
    return () => source.close()
  }, [refresh])

  return reconnecting
}
