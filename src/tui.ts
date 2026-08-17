import { Plugin } from "@opencode-ai/plugin/tui"
import { Duration, Effect } from "effect"
import type { Wait } from "./domain.ts"
import * as WaitDuration from "./duration.ts"
import * as Node from "./node.ts"
import * as Store from "./store.ts"

/**
 * The trigger half of the plugin.
 *
 * A slash command defined by a *server* plugin is only a prompt template, so
 * running it always submits a prompt and schedules model execution — which
 * fails exactly when you are rate limited and most want to defer work. A TUI
 * slash command runs before any model dispatch, so scheduling here costs no
 * model call at all.
 *
 * This half only records the wait. The server half owns the timer, so a wait
 * still fires once the TUI is closed.
 */
export default Plugin.define({
  id: "opencode-schedule-prompt",
  setup: (ctx) => {
    const store = Store.make(Node.fileSystem, Store.directory())
    const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
      Effect.runPromise(effect as Effect.Effect<A, never>)

    const currentSession = (): string | undefined => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    /**
     * The session a wait belongs to.
     *
     * On the home screen there is no session yet, because OpenCode only
     * creates one when a message is sent — which needs a model call, the very
     * thing this command exists to avoid. So one is created directly.
     */
    const targetSession = async (): Promise<string> => {
      const current = currentSession()
      if (current !== undefined) return current
      const created = await ctx.client.session.create({})
      return created.id
    }

    const describe = (wait: Wait, now: number): string =>
      `${wait.id}  in ${Duration.format(Duration.millis(Math.max(0, wait.firesAt - now)))}  ${JSON.stringify(wait.prompt)}`

    const fail = (message: string) =>
      ctx.ui.toast.show({ message, variant: "error", title: "wait" })

    const schedule = async (input?: string) => {
      const text = (input ?? "").trim()
      const split = text.indexOf(" ")
      if (split < 1) {
        return void fail("Usage: /wait <duration> <prompt>, e.g. /wait 1hour implement this")
      }

      const parsed = await Effect.runPromise(
        WaitDuration.parse(text.slice(0, split)).pipe(
          Effect.map((duration) => ({ ok: true as const, duration })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.display })),
        ),
      )
      if (!parsed.ok) return void fail(parsed.message)
      const duration = parsed.duration

      const prompt = text.slice(split + 1).trim()
      if (prompt === "") return void fail("Nothing to schedule: a prompt is required.")

      const now = Date.now()
      try {
        const session = await targetSession()
        const wait = await run(
          store.create({
            sessionID: session as Wait["sessionID"],
            prompt,
            duration: duration,
            createdAt: now,
            firesAt: now + Duration.toMillis(duration),
          }),
        )
        ctx.ui.toast.show({
          title: "wait",
          variant: "success",
          message: `Scheduled ${wait.id} in ${Duration.format(duration)}. Cancel with /wait-cancel ${wait.id}.`,
        })
      } catch (cause) {
        fail(`Could not save the wait: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }

    const list = async (input?: string) => {
      const session = currentSession()
      const all = (input ?? "").trim() === "all"
      const waits = await run(store.list)
      const mine = all ? waits : waits.filter((wait) => wait.sessionID === session)
      if (mine.length === 0) {
        return void ctx.ui.toast.show({
          title: "wait",
          message: all ? "No pending waits." : "No pending waits in this session.",
        })
      }
      const now = Date.now()
      ctx.ui.toast.show({
        title: `wait (${mine.length} pending)`,
        message: mine.map((wait) => describe(wait, now)).join("\n"),
        duration: 8000,
      })
    }

    const cancel = async (input?: string) => {
      const session = currentSession()
      const target = (input ?? "").trim()
      const waits = await run(store.list)
      const mine = waits.filter((wait) => wait.sessionID === session)

      if (target === "all") {
        for (const wait of mine) await run(store.remove(wait.id))
        return void ctx.ui.toast.show({
          title: "wait",
          message: mine.length === 0 ? "No pending waits to cancel." : `Cancelled ${mine.length}.`,
        })
      }

      const found = mine.find((wait) => wait.id === target)
      if (found === undefined) {
        return void fail(
          mine.length === 0
            ? "No pending waits in this session."
            : `Unknown wait ${JSON.stringify(target)}. Pending: ${mine.map((w) => w.id).join(", ")}`,
        )
      }
      await run(store.remove(found.id))
      ctx.ui.toast.show({ title: "wait", variant: "success", message: `Cancelled ${found.id}.` })
    }

    // `keymap.layer` is owned by the calling component and needs a live
    // Keymap provider, so it cannot be called bare in `setup`. Claiming the
    // `app` slot gives a mounted component to register from; it renders
    // nothing.
    ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          commands: [
            {
              id: "schedule-prompt.wait",
              title: "Schedule a prompt for later",
              group: "wait",
              slash: { name: "wait", arguments: true },
              run: (input) => void schedule(input),
            },
            {
              id: "schedule-prompt.list",
              title: "List scheduled prompts",
              group: "wait",
              slash: { name: "wait-list", arguments: true },
              run: (input) => void list(input),
            },
            {
              id: "schedule-prompt.cancel",
              title: "Cancel a scheduled prompt",
              group: "wait",
              slash: { name: "wait-cancel", arguments: true },
              run: (input) => void cancel(input),
            },
          ],
        }))
        return null
      },
    })
  },
})
