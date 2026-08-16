import type { Plugin } from "@opencode-ai/plugin/effect"
import { Context, Effect, Layer } from "effect"
import type { Wait } from "./domain.ts"
import type { Resolved } from "./options.ts"

/**
 * Sends a matured wait back into its session.
 *
 * Split out from the scheduler so tests can observe deliveries without an
 * OpenCode server.
 */
export interface Interface {
  readonly deliver: (wait: Wait) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("opencode-wait/Delivery") {}

export const layer = (ctx: Plugin.Context, options: Resolved): Layer.Layer<Service> =>
  Layer.succeed(
    Service,
    Service.of({
      deliver: Effect.fn("Delivery.deliver")(function* (wait: Wait) {
        yield* ctx.session
          .prompt({
            sessionID: wait.sessionID,
            text: wait.prompt,
            delivery: options.delivery,
          })
          .pipe(
            Effect.asVoid,
            // The wait has already matured; nothing upstream can retry it, so
            // a failed delivery is reported rather than propagated.
            Effect.catchCause((cause) =>
              Effect.logError(`opencode-wait: failed to deliver wait ${wait.id}`, cause),
            ),
          )
      }),
    }),
  )
