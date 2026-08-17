import { watch } from "node:fs"
import { Plugin } from "@opencode-ai/plugin/effect"
import { Context, Effect, Layer } from "effect"
import * as Delivery from "./delivery.ts"
import * as Node from "./node.ts"
import * as Options from "./options.ts"
import * as Store from "./store.ts"
import * as Supervisor from "./supervisor.ts"
import * as Tools from "./tools.ts"

export default Plugin.define({
  id: "opencode-waits",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* Options.resolve(ctx.options)
      const root = Store.directory()
      const store = Store.make(Node.fileSystem, root)

      const probe: Supervisor.SessionProbe = {
        exists: (sessionID) =>
          ctx.session.get({ sessionID }).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
      }

      // Built into the plugin's own scope. `Effect.provide` would release the
      // supervisor as soon as setup returned, taking every timer with it.
      const context = yield* Layer.build(
        Layer.effect(SupervisorTag, Supervisor.make(store, probe)).pipe(
          Layer.provide(Delivery.layer(ctx.session, options)),
        ),
      )
      const supervisor = Context.get(context, SupervisorTag)

      // Arm whatever survived the last shutdown, firing anything overdue.
      yield* supervisor.sync

      // The TUI entrypoint creates waits by writing files here; this process
      // owns the timers, so it has to notice them.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const watcher = watch(root, { persistent: false }, () => {
            Effect.runFork(supervisor.sync)
          })
          watcher.on("error", () => {})
          return watcher
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
        (watcher) => Effect.sync(() => watcher?.close()),
      )

      if (options.tools) {
        yield* ctx.tool.transform((tools) => {
          for (const tool of Tools.all(supervisor)) tools.add(tool)
        })
      }
    }),
})

class SupervisorTag extends Context.Service<SupervisorTag, Supervisor.Interface>()(
  "opencode-waits/Supervisor",
) {}

export { Delivery, Options, Store, Supervisor, Tools }
