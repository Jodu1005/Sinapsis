export interface ClockTimer {
  cancel(): void
}

export interface Clock {
  now(): Date
  setTimeout(callback: () => void, delayMs: number): ClockTimer
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimer {
    const timer = globalThis.setTimeout(callback, delayMs)
    timer.unref?.()
    return { cancel: () => globalThis.clearTimeout(timer) }
  }
}
