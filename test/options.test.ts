import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defaults, resolve } from "../src/options.ts"

const resolveSync = (input: unknown) => Effect.runSync(resolve(input))

describe("options.resolve", () => {
  test("defaults to queue delivery for {}", () => {
    expect(resolveSync({})).toEqual({ delivery: "queue", tools: false })
  })

  test("defaults to queue delivery for undefined", () => {
    expect(resolveSync(undefined)).toEqual({ delivery: "queue", tools: false })
  })

  test("defaults.delivery matches the resolved default", () => {
    expect(defaults.delivery).toBe("queue")
  })

  test("honours an explicit steer delivery", () => {
    expect(resolveSync({ delivery: "steer", tools: false })).toEqual({
      delivery: "steer",
      tools: false,
    })
  })

  test("honours an explicit queue delivery", () => {
    expect(resolveSync({ delivery: "queue", tools: false })).toEqual({
      delivery: "queue",
      tools: false,
    })
  })

  test("falls back to the default for an unknown delivery literal", () => {
    expect(resolveSync({ delivery: "nope" })).toEqual({ delivery: "queue", tools: false })
  })

  test("falls back to the default for a wrongly typed delivery", () => {
    expect(resolveSync({ delivery: 5 })).toEqual({ delivery: "queue", tools: false })
  })

  test("falls back to the default for a non-object input", () => {
    expect(resolveSync("not an object")).toEqual({ delivery: "queue", tools: false })
  })

  test("falls back to the default for null", () => {
    expect(resolveSync(null)).toEqual({ delivery: "queue", tools: false })
  })

  test("falls back to the default when extra unknown fields are present", () => {
    expect(resolveSync({ delivery: "steer", extra: true })).toEqual({
      delivery: "steer",
      tools: false,
    })
  })
})
