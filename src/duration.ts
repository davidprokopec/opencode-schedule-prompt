import { Duration, Effect, Schema } from "effect"

/** Longest wait the plugin accepts. Waits do not survive a restart, so an
 * unbounded delay would silently promise something it cannot keep. */
export const maximum: Duration.Duration = Duration.days(30)

export class InvalidDuration extends Schema.TaggedErrorClass<InvalidDuration>()(
  "opencode-wait/InvalidDuration",
  {
    input: Schema.String,
    reason: Schema.String,
  },
) {
  get display(): string {
    return `Invalid duration ${JSON.stringify(this.input)}: ${this.reason}`
  }
}

const second = 1_000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour
const week = 7 * day

const units: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: second,
  sec: second,
  secs: second,
  second: second,
  seconds: second,
  m: minute,
  min: minute,
  mins: minute,
  minute: minute,
  minutes: minute,
  h: hour,
  hr: hour,
  hrs: hour,
  hour: hour,
  hours: hour,
  d: day,
  day: day,
  days: day,
  w: week,
  week: week,
  weeks: week,
}

/** Matches one `<amount><unit>` segment at exactly the current offset. */
const segment = /(\d+(?:\.\d+)?)([a-z]*)/y

/**
 * Parses a human duration such as `60s`, `1hour`, `2h30m`, `1.5 days`.
 *
 * A bare number is read as seconds, but only when it is the whole input, so
 * `1h30` is rejected as ambiguous rather than silently read as 1h30s.
 */
export const parse = (input: string): Effect.Effect<Duration.Duration, InvalidDuration> => {
  const trimmed = input.trim()
  const fail = (reason: string) => Effect.fail(new InvalidDuration({ input: trimmed, reason }))

  if (trimmed === "") return fail("no duration given")

  const normalized = trimmed.toLowerCase().replace(/[\s,_]+/g, "")
  let total = 0
  let segments = 0
  segment.lastIndex = 0

  while (segment.lastIndex < normalized.length) {
    const offset = segment.lastIndex
    const match = segment.exec(normalized)
    const amount = match?.[1]
    const unit = match?.[2]
    if (amount === undefined || unit === undefined) {
      return fail(`expected a number at ${JSON.stringify(normalized.slice(offset))}`)
    }

    const value = Number(amount)
    if (!Number.isFinite(value)) return fail(`${amount} is not a finite number`)

    if (unit === "") {
      if (segments !== 0 || segment.lastIndex !== normalized.length) {
        return fail(`missing unit after ${JSON.stringify(amount)}`)
      }
      total += value * second
    } else {
      const scale = units[unit]
      if (scale === undefined) return fail(`unknown unit ${JSON.stringify(unit)}`)
      total += value * scale
    }
    segments += 1
  }

  if (segments === 0) return fail("no duration given")
  if (total <= 0) return fail("duration must be greater than zero")

  const duration = Duration.millis(Math.round(total))
  if (Duration.isGreaterThan(duration, maximum)) {
    return fail(`duration must not exceed ${Duration.format(maximum)}`)
  }
  return Effect.succeed(duration)
}
