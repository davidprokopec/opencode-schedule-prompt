import { Plugin } from "@opencode-ai/plugin/tui"
import { Duration, Effect } from "effect"
import type { Wait } from "./domain.ts"
import * as WaitDuration from "./duration.ts"
import { Manager, type ManagerRow } from "./manager.tsx"
import * as Node from "./node.ts"
import { type Row, Waits } from "./sidebar.tsx"
import * as Store from "./store.ts"

type Action = "send" | "delete" | "edit" | "reschedule"

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
  id: "opencode-waits",
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

    /** Rounded to whole seconds; millisecond precision is just noise here. */
    const until = (firesAt: number, now: number): string =>
      Duration.format(Duration.seconds(Math.max(0, Math.round((firesAt - now) / 1000))))

    const fail = (message: string) =>
      ctx.ui.toast.show({ message, variant: "error", title: "Waits" })

    const schedule = async (input?: string) => {
      // The palette invokes commands with no input, so ask for it rather than
      // dead ending on a usage message.
      let text = (input ?? "").trim()
      if (text === "") {
        const answer = await ctx.ui.dialog.prompt({
          title: "Schedule a wait",
          description: "A delay, then the prompt to send once it elapses",
          placeholder: "1hour implement this",
        })
        if (answer === undefined) return
        text = answer.trim()
        if (text === "") return
      }

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
            duration,
            createdAt: now,
            firesAt: now + Duration.toMillis(duration),
          }),
        )
        ctx.ui.toast.show({
          title: "Waits",
          variant: "success",
          message: `Scheduled ${wait.id} in ${Duration.format(duration)}. Cancel with /wait-cancel ${wait.id}.`,
        })
      } catch (cause) {
        fail(`Could not save the wait: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }

    // Reactive so the manager re-renders on every keystroke and so its keymap
    // layer can enable itself only while the dialog is open.
    const [manager, mutateManager] = ctx.storage.memory<{
      open: boolean
      query: string
      index: number
      rows: ManagerRow[]
    }>("manager", { initial: { open: false, query: "", index: 0, rows: [] } })

    const managerRows = async (): Promise<ManagerRow[]> => {
      const waits = await run(store.list)
      const now = Date.now()
      const session = currentSession()
      return waits.map((wait) => ({
        id: wait.id,
        title: `${wait.id}  ${wait.prompt}`,
        meta:
          `in ${until(wait.firesAt, now)}` + (wait.attempts > 0 ? `, ${wait.attempts} failed` : ""),
        category: wait.sessionID === session ? "This session" : "Other sessions",
      }))
    }

    /** Rows matching the search, with the highlight clamped into range. */
    const visible = (): ReadonlyArray<ManagerRow> => {
      const query = manager.query.trim().toLowerCase()
      return query === ""
        ? manager.rows
        : manager.rows.filter((row) => row.title.toLowerCase().includes(query))
    }

    const highlighted = (): ManagerRow | undefined =>
      visible()[Math.min(manager.index, Math.max(0, visible().length - 1))]

    const move = (delta: number) =>
      mutateManager((draft) => {
        const count = visible().length
        if (count === 0) return
        draft.index = (Math.min(draft.index, count - 1) + delta + count) % count
      })

    const refreshManager = async () => {
      const rows = await managerRows()
      mutateManager((draft) => {
        draft.rows = rows
        draft.index = Math.max(0, Math.min(draft.index, rows.length - 1))
      })
    }

    /**
     * The wait manager, rendered by this plugin rather than through
     * `ui.dialog.select`, which cannot express an action footer or direct
     * keybinds; see manager.tsx.
     */
    const openMenu = async () => {
      const rows = await managerRows()
      mutateManager((draft) => {
        draft.rows = rows
        draft.query = ""
        draft.index = 0
        draft.open = true
      })

      const colors = {
        text: ctx.theme.text.default,
        subdued: ctx.theme.text.subdued,
        activeText: ctx.theme.text.action.primary.focused,
        activeBg: ctx.theme.background.action.primary.focused,
      }

      ctx.ui.dialog.show(
        () =>
          Manager({
            title: `Waits (${manager.rows.length})`,
            rows: visible(),
            index: manager.index,
            empty: manager.query.trim() === "" ? "No pending waits." : "No results found",
            actions: [
              { title: "actions", label: "enter" },
              { title: "delete", label: "ctrl+d" },
              { title: "edit", label: "ctrl+e" },
            ],
            colors,
            onQuery: (value) =>
              mutateManager((draft) => {
                draft.query = value
                draft.index = 0
              }),
            onSubmit: () => {
              const row = highlighted()
              if (row !== undefined) void openActions(row.id)
            },
          }),
        () =>
          mutateManager((draft) => {
            draft.open = false
          }),
      )
    }

    /** ctrl+d: cancel the highlighted wait without leaving the manager. */
    const quickDelete = async () => {
      const row = highlighted()
      if (row === undefined) return
      await run(store.remove(row.id))
      await refreshManager()
      ctx.ui.toast.show({ title: "Waits", variant: "success", message: `Cancelled ${row.id}.` })
    }

    /** ctrl+e: edit the highlighted wait's prompt, then return to the list. */
    const quickEdit = async () => {
      const row = highlighted()
      if (row === undefined) return
      const waits = await run(store.list)
      const wait = waits.find((candidate) => candidate.id === row.id)
      if (wait === undefined) return void fail(`Wait ${row.id} is gone.`)
      const edited = await ctx.ui.dialog.prompt({
        title: `Edit ${wait.id}`,
        description: "The prompt delivered when this wait fires",
        value: wait.prompt,
      })
      if (edited !== undefined && edited.trim() !== "") {
        await run(store.update({ ...wait, prompt: edited.trim() }))
        ctx.ui.toast.show({ title: "Waits", variant: "success", message: `Updated ${wait.id}.` })
      }
      await refreshManager()
    }

    /** The action menu for one wait, shared by the list and the sidebar. */
    const openActions = async (id: string) => {
      const waits = await run(store.list)
      const wait = waits.find((candidate) => candidate.id === id)
      if (wait === undefined) return void fail(`Wait ${id} is gone.`)
      const action = await ctx.ui.dialog.select<Action>({
        title: `${wait.id}  ${wait.prompt}`,
        placeholder: "Search actions",
        options: [
          { title: "Send now", value: "send", description: "deliver the prompt immediately" },
          { title: "Reschedule", value: "reschedule", description: "change when it fires" },
          { title: "Edit", value: "edit", description: "change the prompt text" },
          { title: "Delete", value: "delete", description: "cancel this wait" },
        ],
      })
      if (action === undefined) return
      await act(action, wait.id)
    }

    /** Runs one manager action against a wait. */
    const act = async (action: Action, id: string) => {
      const waits = await run(store.list)
      const wait = waits.find((candidate) => candidate.id === id)
      if (wait === undefined) return void fail(`Wait ${id} is gone.`)

      const done = (message: string) => {
        ctx.ui.dialog.clear()
        ctx.ui.toast.show({ title: "Waits", variant: "success", message })
      }

      if (action === "delete") {
        await run(store.remove(wait.id))
        return done(`Cancelled ${wait.id}.`)
      }

      if (action === "send") {
        // Claimed first so the server half cannot also deliver it; losing the
        // claim means it is already on its way.
        const claimed = await run(store.claim(wait.id))
        if (!claimed) return void fail(`${wait.id} was already delivered or cancelled.`)
        await ctx.client.session.prompt({ sessionID: wait.sessionID, text: wait.prompt })
        return done(`Sent ${wait.id} now.`)
      }

      if (action === "edit") {
        ctx.ui.dialog.clear()
        const edited = await ctx.ui.dialog.prompt({
          title: `Edit ${wait.id}`,
          description: "The prompt delivered when this wait fires",
          value: wait.prompt,
        })
        if (edited === undefined || edited.trim() === "") return
        await run(store.update({ ...wait, prompt: edited.trim() }))
        return void ctx.ui.toast.show({
          title: "Waits",
          variant: "success",
          message: `Updated ${wait.id}.`,
        })
      }

      ctx.ui.dialog.clear()
      const answer = await ctx.ui.dialog.prompt({
        title: `Reschedule ${wait.id}`,
        description: "How long from now, e.g. 30m, 2h, 1 day",
        value: "1h",
      })
      if (answer === undefined || answer.trim() === "") return
      const parsed = await Effect.runPromise(
        WaitDuration.parse(answer).pipe(
          Effect.map((duration) => ({ ok: true as const, duration })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.display })),
        ),
      )
      if (!parsed.ok) return void fail(parsed.message)
      const at = Date.now() + Duration.toMillis(parsed.duration)
      await run(store.update({ ...wait, duration: parsed.duration, firesAt: at, attempts: 0 }))
      ctx.ui.toast.show({
        title: "Waits",
        variant: "success",
        message: `${wait.id} now fires in ${Duration.format(parsed.duration)}.`,
      })
    }

    const list = () => void openMenu()

    const cancel = async (input?: string) => {
      const session = currentSession()
      const target = (input ?? "").trim()
      // Without an id there is nothing to cancel, so hand over to the manager.
      if (target === "") return void openMenu()
      const waits = await run(store.list)
      const mine = waits.filter((wait) => wait.sessionID === session)

      if (target === "all") {
        for (const wait of mine) await run(store.remove(wait.id))
        return void ctx.ui.toast.show({
          title: "Waits",
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
      ctx.ui.toast.show({ title: "Waits", variant: "success", message: `Cancelled ${found.id}.` })
    }

    // Mirrors the pending waits into host-owned reactive state. `storage.memory`
    // returns the TUI's own store, so reading it in a component tracks
    // correctly without this plugin importing solid-js itself.
    const [mirror, setMirror] = ctx.storage.memory<{ rows: Row[] }>("sidebar", {
      initial: { rows: [] },
    })

    const refresh = async () => {
      const waits = await run(store.list)
      const now = Date.now()
      const session = currentSession()
      const rows = waits.map((wait) => ({
        id: wait.id,
        prompt: wait.prompt.length > 28 ? `${wait.prompt.slice(0, 27)}…` : wait.prompt,
        countdown: until(wait.firesAt, now),
        mine: wait.sessionID === session,
      }))
      setMirror((draft) => {
        draft.rows = rows
      })
    }

    void refresh()
    const ticker = setInterval(() => void refresh(), 1000)

    ctx.ui.slot({
      append: "sidebar.content",
      render: () =>
        Waits({
          title: `Waits (${mirror.rows.length})`,
          rows: mirror.rows,
          onOpen: (id) => void openActions(id),
        }),
    })

    // `keymap.layer` is owned by the calling component and needs a live
    // Keymap provider, so it cannot be called bare in `setup`. Claiming the
    // `app` slot gives a mounted component to register from; it renders
    // nothing.
    ctx.ui.slot({
      append: "app",
      render: () => {
        // Manager keys. Enter is the search input's own submit; these cover
        // navigation and the direct actions the footer advertises. Scoped to
        // the open dialog so they cannot shadow anything else.
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          enabled: () => manager.open,
          commands: [
            {
              id: "waits.manager.down",
              title: "Next wait",
              group: "Waits",
              bind: "down",
              run: () => move(1),
            },
            {
              id: "waits.manager.up",
              title: "Previous wait",
              group: "Waits",
              bind: "up",
              run: () => move(-1),
            },
            {
              id: "waits.manager.delete",
              title: "Delete the highlighted wait",
              group: "Waits",
              bind: "ctrl+d",
              run: () => void quickDelete(),
            },
            {
              id: "waits.manager.edit",
              title: "Edit the highlighted wait",
              group: "Waits",
              bind: "ctrl+e",
              run: () => void quickEdit(),
            },
          ],
        }))

        ctx.keymap.layer(() => ({
          // Without `global` the layer defaults to the `base` input mode and
          // is unreachable while the prompt is focused, so the commands run
          // when typed in full but appear in neither slash completion nor the
          // ctrl+p palette.
          mode: "global",
          commands: [
            {
              id: "waits.schedule",
              title: "Schedule a wait",
              description: "Send a prompt to this session after a delay, e.g. /wait 1hour do it",
              group: "Waits",
              palette: true,
              slash: { name: "wait", arguments: true },
              run: (input) => void schedule(input),
            },
            {
              id: "waits.list",
              title: "View waits",
              description: "Browse pending scheduled prompts and cancel one",
              group: "Waits",
              palette: true,
              slash: { name: "wait-list", aliases: ["waits"] },
              run: () => void list(),
            },
            {
              id: "waits.cancel",
              title: "Cancel a wait",
              description: "Cancel a scheduled prompt by id, or all of them",
              group: "Waits",
              // Deliberately not in the palette: it needs an id, and the
              // palette cannot supply one. View waits offers Delete instead.
              slash: { name: "wait-cancel", arguments: true },
              run: (input) => void cancel(input),
            },
          ],
        }))
        return null
      },
    })
    return () => clearInterval(ticker)
  },
})
