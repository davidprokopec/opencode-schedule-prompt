import type { Session } from "@opencode-ai/schema/session"
import { Context, Effect, Layer } from "effect"
import type { Wait } from "./domain.ts"
import type { Delivery as Mode, Resolved } from "./options.ts"

/**
 * Sends a matured wait back into its session.
 *
 * Split out from the supervisor so tests can observe deliveries without an
 * OpenCode server.
 */
export interface Interface {
  /** `false` when the prompt could not be submitted, which re-arms the wait. */
  readonly deliver: (wait: Wait) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("opencode-waits/Delivery") {}

/**
 * The slice of the OpenCode session API this plugin needs.
 *
 * Narrow on purpose so the server plugin context and a plain client can both
 * satisfy it.
 */
export interface SessionPort {
  readonly prompt: (input: {
    readonly sessionID: Session.ID
    readonly text: string
    readonly delivery: Mode
  }) => Effect.Effect<unknown, unknown>
}

export const layer = (session: SessionPort, options: Resolved): Layer.Layer<Service> =>
  Layer.succeed(
    Service,
    Service.of({
      deliver: Effect.fn("Delivery.deliver")(function* (wait: Wait) {
        return yield* session
          .prompt({
            sessionID: wait.sessionID,
            text: wait.prompt,
            delivery: options.delivery,
          })
          .pipe(
            Effect.as(true),
            // Reported rather than propagated: the caller decides whether to
            // re-arm, and nothing upstream of it can retry.
            Effect.catchCause((cause) =>
              Effect.logError(`opencode-waits: failed to deliver wait ${wait.id}`, cause).pipe(
                Effect.as(false),
              ),
            ),
          )
      }),
    }),
  )
