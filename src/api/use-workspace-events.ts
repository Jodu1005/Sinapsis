import { useEffect, useRef, useState } from 'react'

const refreshEvents = [
  'workspace.changed', 'repository.changed', 'channel.changed',
  'message.created', 'message.updated', 'message.deleted',
  'task.created', 'task.status_changed', 'task.review_recorded', 'agent.status_changed', 'agent.configuration_changed',
  'task.artifact_created', 'runtime.text', 'runtime.tool_start', 'runtime.tool_end', 'runtime.queue', 'task.session_updated',
  'conversation.turn_created', 'conversation.turn_updated', 'conversation.phase_changed',
  'conversation.participant_updated', 'conversation.participant_decided',
  'conversation.invocation_updated', 'conversation.invocation_queued', 'conversation.invocation_started', 'conversation.invocation_completed',
  'conversation.handoff_created', 'conversation.turn_completed',
]
const throttledEvents = new Set([
  'task.artifact_created', 'runtime.text', 'runtime.tool_start', 'runtime.tool_end', 'runtime.queue', 'task.session_updated',
  'conversation.turn_created', 'conversation.turn_updated', 'conversation.phase_changed',
  'conversation.participant_updated', 'conversation.participant_decided',
  'conversation.invocation_updated', 'conversation.invocation_queued', 'conversation.invocation_started', 'conversation.invocation_completed',
  'conversation.handoff_created', 'conversation.turn_completed',
])

export function useWorkspaceEvents(refresh: () => void): boolean {
  const [reconnecting, setReconnecting] = useState(false)
  const pendingRuntimeRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined
    const source = new EventSource('/events')
    const onChange = (event: Event) => {
      setReconnecting(false)
      if (!throttledEvents.has(event.type)) {
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
