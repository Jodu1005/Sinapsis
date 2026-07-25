import { useEffect, useRef, useState } from 'react'

const refreshEvents = [
  'workspace.changed', 'repository.changed', 'channel.changed', 'message.changed', 'task.changed', 'agent.changed',
  'task.artifact_created', 'runtime.text', 'runtime.tool_start', 'runtime.tool_end', 'runtime.queue', 'task.session_updated',
]
const runtimeEvents = new Set(['task.artifact_created', 'runtime.text', 'runtime.tool_start', 'runtime.tool_end', 'runtime.queue', 'task.session_updated'])

export function useWorkspaceEvents(refresh: () => void): boolean {
  const [reconnecting, setReconnecting] = useState(false)
  const pendingRuntimeRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined
    const source = new EventSource('/events')
    const onChange = (event: Event) => {
      setReconnecting(false)
      if (!runtimeEvents.has(event.type)) {
        refresh()
        return
      }
      if (!pendingRuntimeRefresh.current) {
        pendingRuntimeRefresh.current = setTimeout(() => {
          pendingRuntimeRefresh.current = undefined
          refresh()
        }, 200)
      }
    }
    const onError = () => setReconnecting(true)
    const onOpen = () => { setReconnecting(false); void refresh() }
    refreshEvents.forEach((event) => source.addEventListener(event, onChange))
    source.onerror = onError
    source.onopen = onOpen
    return () => {
      if (pendingRuntimeRefresh.current) clearTimeout(pendingRuntimeRefresh.current)
      source.close()
    }
  }, [refresh])

  return reconnecting
}
