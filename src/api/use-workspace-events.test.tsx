import { act, render } from '@testing-library/react'
import { afterEach } from 'vitest'
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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes the workspace when a channel message is created', () => {
    const originalEventSource = window.EventSource
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource })
    const refresh = vi.fn()
    render(<Harness refresh={refresh} />)

    act(() => FakeEventSource.current?.listeners.get('message.created')?.(new Event('message.created')))

    expect(refresh).toHaveBeenCalledOnce()
    Object.defineProperty(window, 'EventSource', { configurable: true, value: originalEventSource })
  })

  it('refreshes the workspace when Dream or Memory review state changes', () => {
    const originalEventSource = window.EventSource
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource })
    const refresh = vi.fn()
    render(<Harness refresh={refresh} />)

    act(() => FakeEventSource.current?.listeners.get('memory.candidate_reviewed')?.(new Event('memory.candidate_reviewed')))

    expect(refresh).toHaveBeenCalledOnce()
    Object.defineProperty(window, 'EventSource', { configurable: true, value: originalEventSource })
  })

  it('subscribes to conversation events and coalesces them into one throttled refresh', () => {
    vi.useFakeTimers()
    const originalEventSource = window.EventSource
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource })
    const refresh = vi.fn()
    render(<Harness refresh={refresh} />)

    act(() => {
      FakeEventSource.current?.listeners.get('conversation.turn_created')?.(new Event('conversation.turn_created'))
      FakeEventSource.current?.listeners.get('conversation.invocation_updated')?.(new Event('conversation.invocation_updated'))
      FakeEventSource.current?.listeners.get('conversation.turn_completed')?.(new Event('conversation.turn_completed'))
    })
    expect(refresh).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(200))

    expect(refresh).toHaveBeenCalledOnce()
    Object.defineProperty(window, 'EventSource', { configurable: true, value: originalEventSource })
  })

  it('cancels a pending throttled refresh when an immediate refresh event arrives', () => {
    vi.useFakeTimers()
    const originalEventSource = window.EventSource
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource })
    const refresh = vi.fn()
    render(<Harness refresh={refresh} />)

    act(() => {
      FakeEventSource.current?.listeners.get('conversation.invocation_updated')?.(new Event('conversation.invocation_updated'))
      FakeEventSource.current?.listeners.get('message.created')?.(new Event('message.created'))
    })
    expect(refresh).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(200))

    expect(refresh).toHaveBeenCalledOnce()
    Object.defineProperty(window, 'EventSource', { configurable: true, value: originalEventSource })
  })
})
