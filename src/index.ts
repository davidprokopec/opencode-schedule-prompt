import { Plugin } from "@opencode-ai/plugin/effect"
import { Context, Effect, Layer } from "effect"
import * as Commands from "./commands.ts"
import * as Delivery from "./delivery.ts"
import * as Options from "./options.ts"
import * as Scheduler from "./scheduler.ts"
import * as Tools from "./tools.ts"

export default Plugin.define({
  id: "opencode-schedule-prompt",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* Options.resolve(ctx.options)

      // Built into the plugin's own scope rather than with `Effect.provide`,
      // which would release the scheduler as soon as setup returned and take
      // every pending wait with it.
      const context = yield* Layer.build(
        Scheduler.layer.pipe(Layer.provide(Delivery.layer(ctx, options))),
      )
      const scheduler = Context.get(context, Scheduler.Service)

      yield* ctx.tool.transform((tools) => {
        for (const tool of Tools.all(scheduler)) tools.add(tool)
      })

      yield* ctx.command.transform((commands) => {
        for (const definition of Commands.definitions) {
          commands.update(definition.name, (command) => {
            command.description = definition.description
            command.template = definition.template
          })
        }
      })
    }),
})

export { Commands, Delivery, Options, Scheduler, Tools }
