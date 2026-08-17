import { describe, expect, test } from "bun:test"
import { Session } from "@opencode-ai/schema/session"
import { Tool } from "@opencode-ai/schema/tool"
import { Cause, Duration, Effect, Exit, Option } from "effect"
import type { Wait } from "../src/domain.ts"
import type { ScheduleInput, Interface as Scheduler } from "../src/scheduler.ts"
import * as Tools from "../src/tools.ts"

/** Builds a `Wait` with sensible defaults, overridable per test. */
const makeWait = (overrides: Partial<Wait> = {}): Wait => ({
  id: "w1",
  sessionID: Session.ID.create(),
  prompt: "go",
  duration: Duration.minutes(1),
  createdAt: 0,
  firesAt: 60_000,
  attempts: 0,
  ...overrides,
})

/** A stub `Scheduler.Interface` that records every call it receives and
 * returns canned values, so tool executors can be tested without a real
 * OpenCode server or the scheduler's own fiber machinery. */
const stubScheduler = (
  config: {
    schedule?: (input: ScheduleInput) => Wait
    cancel?: (sessionID: Session.ID, id: string) => Option.Option<Wait>
    cancelAll?: (sessionID: Session.ID) => ReadonlyArray<Wait>
    list?: (sessionID: Session.ID) => ReadonlyArray<Wait>
  } = {},
) => {
  const calls = {
    schedule: [] as Array<ScheduleInput>,
    cancel: [] as Array<{ sessionID: Session.ID; id: string }>,
    cancelAll: [] as Array<Session.ID>,
    list: [] as Array<Session.ID>,
  }

  const scheduler: Scheduler = {
    schedule: (input) => {
      calls.schedule.push(input)
      const wait = config.schedule
        ? config.schedule(input)
        : makeWait({ sessionID: input.sessionID, prompt: input.prompt, duration: input.duration })
      return Effect.succeed(wait)
    },
    cancel: (sessionID, id) => {
      calls.cancel.push({ sessionID, id })
      return Effect.succeed(config.cancel ? config.cancel(sessionID, id) : Option.none())
    },
    cancelAll: (sessionID) => {
      calls.cancelAll.push(sessionID)
      return Effect.succeed(config.cancelAll ? config.cancelAll(sessionID) : [])
    },
    list: (sessionID) => {
      calls.list.push(sessionID)
      return Effect.succeed(config.list ? config.list(sessionID) : [])
    },
  }

  return { scheduler, calls }
}

/** A fake `Tool.Context`. Cast is unavoidable: the real fields are branded
 * types (`Session.ID`, `Agent.ID`, ...) with no public constructor for tests
 * to call, and nothing under test reads more than `sessionID`. */
const fakeContext = (overrides: Partial<Tool.Context> = {}): Tool.Context =>
  ({
    sessionID: Session.ID.create(),
    agent: "test-agent",
    messageID: "test-message",
    id: "test-call",
    progress: () => Effect.void,
    ...overrides,
  }) as unknown as Tool.Context

const findTool = (tools: ReadonlyArray<Tool.Info>, name: string): Tool.Info => {
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`no such tool: ${name}`)
  return found
}

/** All three tools always resolve `content` to a plain string; asserting
 * that here keeps the rest of the tests free of `Content[]` narrowing. */
const contentText = (result: Tool.Result): string => {
  if (typeof result.content !== "string") {
    throw new Error(`expected string content, got ${JSON.stringify(result.content)}`)
  }
  return result.content
}

/** Runs a tool executor and asserts it failed with a typed `Tool.Error`
 * rather than crashing with a defect (a thrown exception). Distinguishing
 * the two matters because a provider can send payloads that violate the
 * declared input type (e.g. `null` for an optional string), and the
 * executor must turn that into a normal typed failure, not blow up. */
const runExpectingToolError = async (
  effect: Effect.Effect<Tool.Result, Tool.Error>,
): Promise<Tool.Error> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`)
  }
  if (Cause.hasDies(exit.cause)) {
    throw new Error(
      `expected a typed Tool.Error, got a defect (thrown exception) instead: ${Cause.pretty(exit.cause)}`,
    )
  }
  const error = Cause.squash(exit.cause)
  if (!(error instanceof Tool.Error)) {
    throw new Error(`expected a Tool.Error, got ${JSON.stringify(error)}`)
  }
  return error
}

describe("Tools.all", () => {
  test("every tool declares a properly typed object input schema", () => {
    // Regression guard: `wait_list` used to declare `Schema.Struct({})`,
    // which OpenCode serializes to `{"anyOf":[{"type":"object"},{"type":"array"}]}`
    // — a JSON Schema with no top-level `type`. Anthropic rejects every tool
    // in the request when even one tool schema is missing `type`, which
    // bricks the whole session, not just the offending tool. This loops over
    // every tool (including ones added later) so the same mistake cannot
    // silently reappear.
    const { scheduler } = stubScheduler()
    const tools = Tools.all(scheduler)
    expect(tools.length).toBeGreaterThan(0)

    for (const tool of tools) {
      const input: unknown = tool.input

      if (typeof input === "object" && input !== null && "fields" in input) {
        // An Effect `Schema.Struct`. An empty struct is exactly what
        // serializes to the untyped `anyOf` that broke Anthropic, so require
        // at least one declared field.
        const fields = (input as { fields: Record<string, unknown> }).fields
        expect(
          Object.keys(fields).length,
          `${tool.name}: Schema.Struct input declares no fields, which serializes to an ` +
            `untyped JSON Schema (no top-level "type") and breaks every tool in the session`,
        ).toBeGreaterThan(0)
      } else {
        // Raw JSON Schema must declare its own top-level "type".
        expect(
          (input as { type?: unknown } | null)?.type,
          `${tool.name}: raw JSON Schema input must set "type": "object" at the top level, ` +
            `or the Anthropic API rejects every tool in the session`,
        ).toBe("object")
      }
    }
  })

  test("every tool is restricted to direct provider exposure (codemode: false)", () => {
    const { scheduler } = stubScheduler()
    for (const tool of Tools.all(scheduler)) {
      expect(tool.options?.codemode, `${tool.name}: expected options.codemode === false`).toBe(
        false,
      )
    }
  })
})

describe("wait_schedule", () => {
  test("rejects an empty prompt without calling scheduler.schedule", async () => {
    const { scheduler, calls } = stubScheduler()
    const tool = findTool(Tools.all(scheduler), "wait_schedule")
    const context = fakeContext()

    const error = await runExpectingToolError(
      tool.execute({ duration: "5m", prompt: "" }, context) as Effect.Effect<
        Tool.Result,
        Tool.Error
      >,
    )

    expect(error.message).toContain("prompt is required")
    expect(calls.schedule).toHaveLength(0)
  })

  test("rejects a whitespace-only prompt without calling scheduler.schedule", async () => {
    const { scheduler, calls } = stubScheduler()
    const tool = findTool(Tools.all(scheduler), "wait_schedule")
    const context = fakeContext()

    const error = await runExpectingToolError(
      tool.execute({ duration: "5m", prompt: "   " }, context) as Effect.Effect<
        Tool.Result,
        Tool.Error
      >,
    )

    expect(error.message).toContain("prompt is required")
    expect(calls.schedule).toHaveLength(0)
  })

  test("rejects an unparseable duration, mentioning the bad input, without scheduling", async () => {
    const { scheduler, calls } = stubScheduler()
    const tool = findTool(Tools.all(scheduler), "wait_schedule")
    const context = fakeContext()

    const error = await runExpectingToolError(
      tool.execute({ duration: "soon", prompt: "do the thing" }, context) as Effect.Effect<
        Tool.Result,
        Tool.Error
      >,
    )

    expect(error.message).toContain("soon")
    expect(calls.schedule).toHaveLength(0)
  })

  test("passes the parsed duration and sessionID through, trims the prompt, and reports the wait id", async () => {
    const wait = makeWait({ id: "w42" })
    const { scheduler, calls } = stubScheduler({ schedule: () => wait })
    const tool = findTool(Tools.all(scheduler), "wait_schedule")
    const context = fakeContext({ sessionID: wait.sessionID })

    const result = await Effect.runPromise(
      tool.execute({ duration: "5m", prompt: "  do the thing  " }, context) as Effect.Effect<
        Tool.Result,
        Tool.Error
      >,
    )

    expect(calls.schedule).toHaveLength(1)
    const call = calls.schedule[0]
    if (call === undefined) throw new Error("expected scheduler.schedule to have been called")
    expect(call.sessionID).toBe(context.sessionID)
    expect(call.prompt).toBe("do the thing")
    expect(Duration.toMillis(call.duration)).toBe(Duration.toMillis(Duration.minutes(5)))

    expect(contentText(result)).toContain(wait.id)
  })
})

describe("wait_list", () => {
  test("reports no pending waits when the scheduler returns none", async () => {
    const { scheduler } = stubScheduler({ list: () => [] })
    const tool = findTool(Tools.all(scheduler), "wait_list")
    const context = fakeContext()

    const result = await Effect.runPromise(
      tool.execute({}, context) as Effect.Effect<Tool.Result, Tool.Error>,
    )

    expect(contentText(result).toLowerCase()).toContain("no pending waits")
  })

  test("lists each pending wait's id and prompt", async () => {
    const first = makeWait({ id: "w1", prompt: "first prompt" })
    const second = makeWait({ id: "w2", prompt: "second prompt" })
    const { scheduler } = stubScheduler({ list: () => [first, second] })
    const tool = findTool(Tools.all(scheduler), "wait_list")
    const context = fakeContext()

    const result = await Effect.runPromise(
      tool.execute({}, context) as Effect.Effect<Tool.Result, Tool.Error>,
    )

    const content = contentText(result)
    expect(content).toContain(first.id)
    expect(content).toContain(JSON.stringify(first.prompt))
    expect(content).toContain(second.id)
    expect(content).toContain(JSON.stringify(second.prompt))
  })
})

describe("wait_cancel", () => {
  describe("missing id regression guard", () => {
    // `Schema.optional` renders as `anyOf: [string, null]`, so a provider may
    // legitimately send `{ id: null }` rather than omitting the field. The
    // executor must treat that exactly like a missing id — a typed
    // `Tool.Error`, never a thrown defect.
    const pending = makeWait({ id: "w1", prompt: "go" })

    for (const [label, rawInput] of [
      ["missing entirely", {}],
      ["explicit null", { id: null }],
      ["whitespace only", { id: "  " }],
    ] as const) {
      test(`{ id } ${label} fails with a Tool.Error, not a defect`, async () => {
        const { scheduler, calls } = stubScheduler({ list: () => [pending] })
        const tool = findTool(Tools.all(scheduler), "wait_cancel")
        const context = fakeContext()

        const error = await runExpectingToolError(
          tool.execute(rawInput, context) as Effect.Effect<Tool.Result, Tool.Error>,
        )

        expect(error.message.length).toBeGreaterThan(0)
        expect(error.message).toContain("cancel")
        expect(calls.cancel).toHaveLength(0)
        expect(calls.cancelAll).toHaveLength(0)
      })
    }
  })

  test("{ all: true } cancels every pending wait via cancelAll and reports the ids", async () => {
    const first = makeWait({ id: "w1", prompt: "first" })
    const second = makeWait({ id: "w2", prompt: "second" })
    const { scheduler, calls } = stubScheduler({ cancelAll: () => [first, second] })
    const tool = findTool(Tools.all(scheduler), "wait_cancel")
    const context = fakeContext()

    const result = await Effect.runPromise(
      tool.execute({ all: true }, context) as Effect.Effect<Tool.Result, Tool.Error>,
    )

    expect(calls.cancelAll).toEqual([context.sessionID])
    expect(calls.cancel).toHaveLength(0)
    const content = contentText(result)
    expect(content).toContain(first.id)
    expect(content).toContain(second.id)
  })

  test("{ all: true } reports nothing to cancel when cancelAll returns none", async () => {
    const { scheduler } = stubScheduler({ cancelAll: () => [] })
    const tool = findTool(Tools.all(scheduler), "wait_cancel")
    const context = fakeContext()

    const result = await Effect.runPromise(
      tool.execute({ all: true }, context) as Effect.Effect<Tool.Result, Tool.Error>,
    )

    expect(contentText(result).toLowerCase()).toContain("no pending waits")
  })

  test("a known id calls cancel and reports success", async () => {
    const wait = makeWait({ id: "w7", prompt: "do it" })
    const { scheduler, calls } = stubScheduler({
      cancel: (_sessionID, id) => (id === wait.id ? Option.some(wait) : Option.none()),
    })
    const tool = findTool(Tools.all(scheduler), "wait_cancel")
    const context = fakeContext()

    const result = await Effect.runPromise(
      tool.execute({ id: wait.id }, context) as Effect.Effect<Tool.Result, Tool.Error>,
    )

    expect(calls.cancel).toEqual([{ sessionID: context.sessionID, id: wait.id }])
    const content = contentText(result)
    expect(content).toContain(wait.id)
    expect(content).toContain(JSON.stringify(wait.prompt))
  })

  test("an unknown id fails with a Tool.Error", async () => {
    const { scheduler, calls } = stubScheduler({ cancel: () => Option.none(), list: () => [] })
    const tool = findTool(Tools.all(scheduler), "wait_cancel")
    const context = fakeContext()

    const error = await runExpectingToolError(
      tool.execute({ id: "w999" }, context) as Effect.Effect<Tool.Result, Tool.Error>,
    )

    expect(calls.cancel).toEqual([{ sessionID: context.sessionID, id: "w999" }])
    expect(error.message).toContain("w999")
  })
})
