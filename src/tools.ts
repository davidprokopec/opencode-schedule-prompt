import { Tool } from "@opencode-ai/schema/tool"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import type { Wait } from "./domain.ts"
import * as WaitDuration from "./duration.ts"
import type { Interface as Scheduler } from "./supervisor.ts"

/** `now` is passed in rather than read from `Date`, so it comes from the same
 * clock that produced `firesAt`. */
const describe = (wait: Wait, now: number): string =>
  `${wait.id}  in ${Duration.format(Duration.millis(Math.max(0, wait.firesAt - now)))}` +
  ` (at ${new Date(wait.firesAt).toISOString()})  ${JSON.stringify(wait.prompt)}`

const scheduleTool = (scheduler: Scheduler) =>
  ({
    name: "wait_schedule",
    description:
      "Schedule a prompt to be sent back to this session after a delay. Returns immediately; " +
      "the prompt is delivered later without any further action. Use this instead of sleeping.",
    input: Schema.Struct({
      duration: Schema.String.annotate({
        description: 'How long to wait, e.g. "60s", "1hour", "2h30m", "3 days".',
      }),
      prompt: Schema.String.annotate({
        description: "The prompt text to send once the delay has elapsed, verbatim.",
      }),
    }),
    options: { codemode: false },
    execute: Effect.fn("wait_schedule")(function* (input, context) {
      const prompt = input.prompt.trim()
      if (prompt === "") {
        return yield* Effect.fail(
          new Tool.Error({
            message: "Nothing to schedule: a prompt is required, e.g. /wait 1hour implement this",
          }),
        )
      }

      const duration = yield* WaitDuration.parse(input.duration).pipe(
        Effect.mapError((error) => new Tool.Error({ message: error.display })),
      )

      const wait = yield* scheduler.schedule({
        sessionID: context.sessionID,
        prompt,
        duration,
      })

      return {
        content:
          `Scheduled ${wait.id}: this prompt will be sent in ${Duration.format(duration)} ` +
          `(at ${new Date(wait.firesAt).toISOString()}). ` +
          `Cancel with /wait-cancel ${wait.id}. Pending waits are lost if OpenCode restarts.`,
      }
    }),
  }) satisfies Tool.Info

const listTool = (scheduler: Scheduler) =>
  ({
    name: "wait_list",
    description: "List the prompts scheduled by wait_schedule that are still pending.",
    // Declared as raw JSON Schema rather than `Schema.Struct({})`, which
    // generates `anyOf: [object, array]` with no top-level `type`. Anthropic
    // rejects every request in the session when a tool schema omits `type`.
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: Effect.fn("wait_list")(function* (_input: unknown, context) {
      const waits = yield* scheduler.list(context.sessionID)
      if (waits.length === 0) return { content: "No pending waits in this session." }
      const now = yield* Clock.currentTimeMillis
      return {
        content: [
          `${waits.length} pending wait(s):`,
          ...waits.map((wait) => describe(wait, now)),
        ].join("\n"),
      }
    }),
  }) satisfies Tool.Info

const cancelTool = (scheduler: Scheduler) =>
  ({
    name: "wait_cancel",
    description: "Cancel a pending wait by id, or every pending wait in this session.",
    input: Schema.Struct({
      id: Schema.optional(
        Schema.String.annotate({ description: 'Id returned by wait_schedule, e.g. "w1".' }),
      ),
      all: Schema.optional(
        Schema.Boolean.annotate({ description: "Cancel every pending wait in this session." }),
      ),
    }),
    options: { codemode: false },
    execute: Effect.fn("wait_cancel")(function* (input, context) {
      // `Schema.optional` renders as `anyOf: [string, null]`, so a provider may
      // legitimately send null rather than omitting the field.
      const id = typeof input.id === "string" ? input.id.trim() : ""

      if (input.all === true) {
        const cancelled = yield* scheduler.cancelAll(context.sessionID)
        if (cancelled.length === 0) return { content: "No pending waits to cancel." }
        return {
          content: `Cancelled ${cancelled.length} wait(s): ${cancelled.map((wait) => wait.id).join(", ")}`,
        }
      }

      if (id === "") {
        const waits = yield* scheduler.list(context.sessionID)
        return yield* Effect.fail(
          new Tool.Error({
            message:
              waits.length === 0
                ? "No pending waits in this session."
                : `Specify which wait to cancel, or pass all: true. Pending: ${waits
                    .map((wait) => wait.id)
                    .join(", ")}`,
          }),
        )
      }

      const cancelled = yield* scheduler.cancel(context.sessionID, id)
      if (Option.isNone(cancelled)) {
        const waits = yield* scheduler.list(context.sessionID)
        return yield* Effect.fail(
          new Tool.Error({
            message: `No pending wait ${JSON.stringify(id)} in this session.${
              waits.length === 0 ? "" : ` Pending: ${waits.map((wait) => wait.id).join(", ")}`
            }`,
          }),
        )
      }

      return {
        content: `Cancelled ${cancelled.value.id}: ${JSON.stringify(cancelled.value.prompt)}`,
      }
    }),
  }) satisfies Tool.Info

export const all = (scheduler: Scheduler): ReadonlyArray<Tool.Info> => [
  scheduleTool(scheduler),
  listTool(scheduler),
  cancelTool(scheduler),
]
