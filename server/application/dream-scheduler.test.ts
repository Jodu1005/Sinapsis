import { describe, expect, it, vi } from 'vitest'
import type { Clock, ClockTimer } from '../ports/clock'
import { DreamScheduler } from './dream-scheduler'

describe('DreamScheduler', () => {
  it('calculates the next 03:00 in Asia/Shanghai across a local day boundary', () => {
    const scheduler = schedulerAt('2026-08-03T18:00:00.000Z', '03:00', 'Asia/Shanghai')

    expect(scheduler.nextRunAt(new Date('2026-08-03T18:00:00.000Z')).toISOString())
      .toBe('2026-08-03T19:00:00.000Z')
    expect(scheduler.nextRunAt(new Date('2026-08-03T20:00:00.000Z')).toISOString())
      .toBe('2026-08-04T19:00:00.000Z')
  })

  it('calculates real local times across both DST transitions', () => {
    const scheduler = schedulerAt('2026-03-08T06:00:00.000Z', '03:00', 'America/New_York')

    expect(scheduler.nextRunAt(new Date('2026-03-08T06:00:00.000Z')).toISOString())
      .toBe('2026-03-08T07:00:00.000Z')
    expect(scheduler.nextRunAt(new Date('2026-11-01T05:30:00.000Z')).toISOString())
      .toBe('2026-11-01T08:00:00.000Z')
  })

  it('uses the first valid instant for a skipped time and only the first instance of a repeated time', () => {
    const skipped = schedulerAt('2026-03-08T06:00:00.000Z', '02:30', 'America/New_York')
    const repeated = schedulerAt('2026-11-01T05:15:00.000Z', '01:30', 'America/New_York')

    expect(skipped.nextRunAt(new Date('2026-03-08T06:00:00.000Z')).toISOString())
      .toBe('2026-03-08T07:00:00.000Z')
    expect(repeated.nextRunAt(new Date('2026-11-01T05:15:00.000Z')).toISOString())
      .toBe('2026-11-01T05:30:00.000Z')
    expect(repeated.nextRunAt(new Date('2026-11-01T05:45:00.000Z')).toISOString())
      .toBe('2026-11-02T06:30:00.000Z')
  })

  it('starts idempotently, schedules after each trigger, and stops its timer', async () => {
    const clock = new FakeClock(new Date('2026-08-03T18:00:00.000Z'))
    const trigger = vi.fn(async () => {})
    const scheduler = new DreamScheduler({ clock, time: '03:00', timeZone: 'Asia/Shanghai', trigger })

    scheduler.start()
    scheduler.start()
    expect(clock.activeTimers()).toHaveLength(1)

    await clock.fireNext()
    expect(trigger).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(clock.activeTimers()).toHaveLength(1))

    scheduler.stop()
    expect(clock.activeTimers()).toHaveLength(0)
  })

  it('keeps scheduling after a trigger failure', async () => {
    const clock = new FakeClock(new Date('2026-08-03T18:00:00.000Z'))
    const scheduler = new DreamScheduler({
      clock, time: '03:00', timeZone: 'Asia/Shanghai', trigger: async () => { throw new Error('queue unavailable') },
    })

    scheduler.start()
    await clock.fireNext()

    await vi.waitFor(() => expect(clock.activeTimers()).toHaveLength(1))
  })

  it('does not let an old in-flight trigger schedule a second timer after stop and restart', async () => {
    const clock = new FakeClock(new Date('2026-08-03T18:00:00.000Z'))
    const inFlight = deferred<void>()
    const scheduler = new DreamScheduler({
      clock, time: '03:00', timeZone: 'Asia/Shanghai', trigger: () => inFlight.promise,
    })

    scheduler.start()
    await clock.fireNext()
    scheduler.stop()
    scheduler.start()
    expect(clock.activeTimers()).toHaveLength(1)

    inFlight.resolve()

    await vi.waitFor(() => expect(clock.activeTimers()).toHaveLength(1))
  })
})

function schedulerAt(now: string, time: string, timeZone: string): DreamScheduler {
  return new DreamScheduler({ clock: new FakeClock(new Date(now)), time, timeZone, trigger: async () => {} })
}

class FakeClock implements Clock {
  private timers: FakeTimer[] = []

  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current)
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimer {
    const timer = new FakeTimer(callback, delayMs)
    this.timers.push(timer)
    return timer
  }

  activeTimers(): FakeTimer[] {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired)
  }

  async fireNext(): Promise<void> {
    const timer = this.activeTimers()[0]
    if (!timer) throw new Error('No active timer.')
    this.current = new Date(this.current.getTime() + timer.delayMs)
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
  }
}

class FakeTimer implements ClockTimer {
  cancelled = false
  fired = false

  constructor(private readonly callback: () => void, readonly delayMs: number) {}

  cancel(): void {
    this.cancelled = true
  }

  fire(): void {
    this.fired = true
    this.callback()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
