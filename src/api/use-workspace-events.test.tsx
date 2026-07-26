import { act, render } from '@testing-library/react'
import { useWorkspaceEvents } from './use-workspace-events'

class FakeEventSource {
  static current: FakeEventSource | undefined
  readonly listeners = new Map<string, EventListener>()
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  constructor(_url: string) { FakeEventSource.current = this }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener) }
  close() {}
}

function Harness({ refresh }: { refresh(): void }) {
  useWorkspaceEvents(refresh)
  return null
}

describe('useWorkspaceEvents', () => {
  it('refreshes the workspace when a channel message is created', () => {
    const originalEventSource = window.EventSource
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource })
    const refresh = vi.fn()
    render(<Harness refresh={refresh} />)

    act(() => FakeEventSource.current?.listeners.get('message.created')?.(new Event('message.created')))

    expect(refresh).toHaveBeenCalledOnce()
    Object.defineProperty(window, 'EventSource', { configurable: true, value: originalEventSource })
  })
})
