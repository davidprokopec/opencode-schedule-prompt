import { Effect, Option, Schema } from "effect"

/**
 * How a matured wait is handed to the session.
 *
 * - `queue` waits for the current turn to finish, so a wait never cuts into
 *   work the user is actively watching.
 * - `steer` injects into the running turn immediately.
 */
export const Delivery = Schema.Literals(["queue", "steer"])
export type Delivery = typeof Delivery.Type

export interface Options extends Schema.Schema.Type<typeof Options> {}
export const Options = Schema.Struct({
  delivery: Schema.optional(Delivery),
  /** Exposes wait_schedule/wait_list/wait_cancel to the model. */
  tools: Schema.optional(Schema.Boolean),
})

export const defaults = {
  delivery: "queue",
  // Off by default: the slash commands never need them, and every exposed
  // tool costs schema tokens in every request.
  tools: false,
} as const satisfies Required<Options>

export interface Resolved {
  readonly delivery: Delivery
  readonly tools: boolean
}

const decodeOption = Schema.decodeUnknownOption(Options)

/**
 * Reads `plugins[].options` from the OpenCode config.
 *
 * A plugin effect cannot fail, and refusing to load over one bad field would
 * take `/wait` away entirely, so an unusable value is reported and the
 * defaults are used instead.
 */
export const resolve = (input: unknown): Effect.Effect<Resolved> =>
  Effect.gen(function* () {
    // OpenCode passes `{}` when no options are configured, but treat an absent
    // value the same way rather than reporting it as broken configuration.
    const decoded = decodeOption(input ?? {})
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning(
        "opencode2-waits: ignoring invalid plugin options, using defaults",
        input,
      )
      return { delivery: defaults.delivery, tools: defaults.tools }
    }
    return {
      delivery: decoded.value.delivery ?? defaults.delivery,
      tools: decoded.value.tools ?? defaults.tools,
    }
  })
