import type { Clock, ClockTimer } from '../ports/clock'

export interface DreamSchedulerOptions {
  clock: Clock
  time: string
  timeZone: string
  trigger: () => void | Promise<void>
}

export class DreamScheduler {
  private readonly clock: Clock
  private readonly hour: number
  private readonly minute: number
  private readonly timeZone: string
  private readonly trigger: () => void | Promise<void>
  private timer: ClockTimer | undefined
  private started = false

  constructor(options: DreamSchedulerOptions) {
    const time = parseTime(options.time)
    assertTimeZone(options.timeZone)
    this.clock = options.clock
    this.hour = time.hour
    this.minute = time.minute
    this.timeZone = options.timeZone
    this.trigger = options.trigger
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleNext()
  }

  stop(): void {
    this.started = false
    this.timer?.cancel()
    this.timer = undefined
  }

  nextRunAt(from: Date): Date {
    const local = zonedParts(from, this.timeZone)
    for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
      const date = addCalendarDays(local.year, local.month, local.day, dayOffset)
      const exact = zonedInstants(date.year, date.month, date.day, this.hour, this.minute, this.timeZone)
      const candidates = exact.length > 0 ? exact : [firstValidInstantAfter(
        date.year, date.month, date.day, this.hour, this.minute, this.timeZone,
      )]
      const next = candidates.find((candidate) => candidate.getTime() > from.getTime())
      if (next) return next
    }
    throw new Error(`Unable to calculate the next Dream time in ${this.timeZone}.`)
  }

  private scheduleNext(): void {
    if (!this.started) return
    const now = this.clock.now()
    const next = this.nextRunAt(now)
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void Promise.resolve()
        .then(() => this.trigger())
        .catch(() => undefined)
        .finally(() => this.scheduleNext())
    }, Math.max(0, next.getTime() - now.getTime()))
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  const hour = Number(match?.[1])
  const minute = Number(match?.[2])
  if (!match || hour > 23 || minute > 59) throw new Error('Dream time must use 24-hour HH:mm format.')
  return { hour, minute }
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  } catch {
    throw new Error('Dream time zone must be a valid IANA time zone.')
  }
}

function zonedParts(value: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value)
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value)
  return { year: number('year'), month: number('month'), day: number('day'), hour: number('hour'), minute: number('minute') }
}

function addCalendarDays(year: number, month: number, day: number, amount: number): { year: number; month: number; day: number } {
  const value = new Date(Date.UTC(year, month - 1, day + amount))
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function zonedInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date[] {
  const target = Date.UTC(year, month - 1, day, hour, minute)
  const offsets = new Set<number>()
  for (let delta = -36; delta <= 36; delta += 6) {
    const probe = new Date(target + delta * 60 * 60 * 1_000)
    const local = zonedParts(probe, timeZone)
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - probe.getTime())
  }
  const matches = [...offsets]
    .map((offset) => new Date(target - offset))
    .filter((candidate) => {
      const local = zonedParts(candidate, timeZone)
      return local.year === year && local.month === month && local.day === day
        && local.hour === hour && local.minute === minute
    })
    .sort((left, right) => left.getTime() - right.getTime())
  return matches
}

function firstValidInstantAfter(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const targetLocal = Date.UTC(year, month - 1, day, hour, minute)
  const searchStart = targetLocal - 18 * 60 * 60 * 1_000
  const searchEnd = targetLocal + 18 * 60 * 60 * 1_000
  for (let timestamp = searchStart; timestamp <= searchEnd; timestamp += 60_000) {
    const candidate = new Date(timestamp)
    const local = zonedParts(candidate, timeZone)
    if (local.year !== year || local.month !== month || local.day !== day) continue
    const localTimestamp = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
    if (localTimestamp >= targetLocal) return candidate
  }
  throw new Error(`Unable to resolve a valid local Dream time in ${timeZone}.`)
}
