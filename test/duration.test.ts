import { describe, expect, test } from "bun:test"
import { Duration, Effect, Result } from "effect"
import { type InvalidDuration, maximum, parse } from "../src/duration.ts"

/** Runs `parse` and returns the millisecond value of a successful parse. */
const millisOf = (input: string): number => {
  const result = Effect.runSync(Effect.result(parse(input)))
  if (Result.isFailure(result)) {
    throw new Error(`expected ${JSON.stringify(input)} to parse, got ${result.failure.display}`)
  }
  return Duration.toMillis(result.success)
}

/** Runs `parse` and returns the `InvalidDuration` failure, or throws if it succeeded. */
const failureOf = (input: string): InvalidDuration => {
  const result = Effect.runSync(Effect.result(parse(input)))
  if (Result.isSuccess(result)) {
    throw new Error(
      `expected ${JSON.stringify(input)} to be rejected, got ${Duration.format(result.success)}`,
    )
  }
  return result.failure
}

describe("duration.parse", () => {
  describe("accepted forms", () => {
    test.each([
      ["60s", 60_000],
      ["1hour", 3_600_000],
      ["1 hour", 3_600_000],
      ["2h30m", 2 * 3_600_000 + 30 * 60_000],
      ["1.5h", 1.5 * 3_600_000],
      ["500ms", 500],
      ["3 days", 3 * 24 * 3_600_000],
      ["1w", 7 * 24 * 3_600_000],
      ["1H", 3_600_000],
      ["1 HOUR", 3_600_000],
      ["  60s  ", 60_000],
      ["1h 30m", 3_600_000 + 30 * 60_000],
    ])("parses %s", (input, expected) => {
      expect(millisOf(input)).toBe(expected)
    })

    test("a bare number is read as seconds", () => {
      expect(millisOf("60")).toBe(60_000)
    })

    test("ms parses as milliseconds, not minutes", () => {
      expect(millisOf("10ms")).toBe(10)
    })

    test("m parses as minutes, not milliseconds", () => {
      expect(millisOf("10m")).toBe(10 * 60_000)
    })
  })

  describe("rejections", () => {
    test.each([
      ["", "empty string"],
      ["   ", "whitespace only"],
      ["abc", "not a number"],
      ["10x", "unknown unit"],
      ["1h30", "bare number after a unit is ambiguous"],
      ["0s", "zero duration"],
      ["31d", "over the maximum"],
    ])("rejects %s (%s)", (input) => {
      const failure = failureOf(input)
      expect(failure._tag).toBe("opencode-wait/InvalidDuration")
      expect(failure.reason.length).toBeGreaterThan(0)
    })

    test("the maximum is exactly 30 days", () => {
      expect(Duration.toMillis(maximum)).toBe(30 * 24 * 3_600_000)
    })

    test("a duration at the maximum is accepted", () => {
      expect(millisOf("30d")).toBe(30 * 24 * 3_600_000)
    })

    test("a duration one unit past the maximum is rejected", () => {
      const failure = failureOf("30d1s")
      expect(failure._tag).toBe("opencode-wait/InvalidDuration")
    })
  })
})
