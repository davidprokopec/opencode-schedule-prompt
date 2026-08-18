import type { Session } from "@opencode-ai/schema/session"
import { Clock, Duration, Effect, FiberMap, Option, Ref, type Scope } from "effect"
import * as Delivery from "./delivery.ts"
import type { Wait, WaitID } from "./domain.ts"
import * as Store from "./store.ts"

export interface ScheduleInput {
  readonly sessionID: Session.ID
  readonly prompt: string
  readonly duration: Duration.Duration
}

export interface Interface {
  readonly schedule: (input: ScheduleInput) => Effect.Effect<Wait>
  readonly cancel: (sessionID: Session.ID, id: WaitID) => Effect.Effect<Option.Option<Wait>>
  readonly cancelAll: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Wait>>
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Wait>>
  /** Every pending wait, across sessions. Backs `/wait-list all`. */
  readonly listAll: Effect.Effect<ReadonlyArray<Wait>>
  /**
   * Arms every wait already on disk.
   *
   * Called on startup, and again whenever the store directory changes, so a
   * wait created by the TUI entrypoint is picked up by this process.
   */
  readonly sync: Effect.Effect<void>
}

/** Sessions that no longer exist cannot receive a prompt. */
export interface SessionProbe {
  readonly exists: (sessionID: Session.ID) => Effect.Effect<boolean>
}

const byFiringOrder = (waits: Iterable<Wait>): ReadonlyArray<Wait> =>
  [...waits].sort((left, right) => left.firesAt - right.firesAt)

/**
 * Owns the timers for every pending wait.
 *
 * The store on disk is the source of truth; this process holds one fiber per
 * wait purely to sleep until it is due. Anything already overdue — because
 * OpenCode was not running when it matured — fires immediately.
 */
export const make = (
  store: Store.Interface,
  probe: SessionProbe,
): Effect.Effect<Interface, never, Delivery.Service | Scope.Scope> =>
  Effect.gen(function* () {
    const delivery = yield* Delivery.Service
    const fibers = yield* FiberMap.make<WaitID>()
    // Ids currently armed in this process, so `sync` is idempotent and can be
    // called on every filesystem event without duplicating timers.
    const armed = yield* Ref.make(new Set<WaitID>())

    const forget = (id: WaitID) =>
      Ref.update(armed, (ids) => new Set([...ids].filter((x) => x !== id)))

    const logStoreFailure = (operation: string) => (error: Store.StoreError) =>
      Effect.logError(`opencode2-waits: ${operation}: ${error.display}`)

    const load = store.list.pipe(
      Effect.catch((error) =>
        logStoreFailure("could not read pending waits")(error).pipe(
          Effect.as([] as ReadonlyArray<Wait>),
        ),
      ),
    )

    /**
     * Takes exclusive ownership of a wait before acting on it.
     *
     * Several processes can watch the same store directory — the shared
     * service and a `--standalone` server, say — and each arms its own timer.
     * Removing the record is atomic, so exactly one of them gets `true` and
     * the wait is delivered once.
     */
    const claim = (wait: Wait): Effect.Effect<boolean> =>
      // A `mem-` wait was never persisted, so it has no record to claim and
      // only this process knows about it.
      wait.id.startsWith("mem-")
        ? Effect.succeed(true)
        : store.claim(wait.id).pipe(
            Effect.tap((owned) =>
              owned
                ? Effect.void
                : Effect.logInfo(`opencode2-waits: ${wait.id} was already claimed elsewhere`),
            ),
            // Conservative: a store that cannot be read must never risk a
            // second delivery, so an unknown failure counts as not owned.
            Effect.catch((error) =>
              logStoreFailure("could not claim wait")(error).pipe(Effect.as(false)),
            ),
          )

    /** Runs when a wait matures: deliver, then settle or re-arm with backoff. */
    const fire = (wait: Wait) =>
      Effect.gen(function* () {
        const owned = yield* claim(wait)
        if (!owned) return

        const alive = yield* probe.exists(wait.sessionID)
        if (!alive) {
          // The claim already removed the record, so there is nothing to drop.
          yield* Effect.logInfo(
            `opencode2-waits: dropping ${wait.id}, session ${wait.sessionID} is gone`,
          )
          return
        }

        const delivered = yield* delivery.deliver(wait)
        if (delivered) return

        const now = yield* Clock.currentTimeMillis
        const retry = Store.nextAttempt(wait, now)
        if (retry === undefined) {
          yield* Effect.logError(
            `opencode2-waits: giving up on ${wait.id} after ${wait.attempts} attempts`,
          )
          return
        }

        yield* Effect.logWarning(
          `opencode2-waits: delivery of ${wait.id} failed, re-arming attempt ${retry.attempts}`,
        )
        yield* store.update(retry).pipe(Effect.catch(logStoreFailure("could not re-arm wait")))
        yield* forget(wait.id)
        yield* arm(retry)
      })

    const arm = (wait: Wait): Effect.Effect<void> =>
      Effect.gen(function* () {
        const already = yield* Ref.get(armed)
        if (already.has(wait.id)) return
        yield* Ref.update(armed, (ids) => new Set(ids).add(wait.id))

        const now = yield* Clock.currentTimeMillis
        // Negative delays fire immediately, which is what we want for a wait
        // that matured while OpenCode was not running.
        const delay = Math.max(0, wait.firesAt - now)
        if (delay > 0 && wait.firesAt < now) {
          yield* Effect.logInfo(`opencode2-waits: ${wait.id} is overdue, firing now`)
        }

        yield* FiberMap.run(
          fibers,
          wait.id,
          Effect.sleep(Duration.millis(delay)).pipe(
            Effect.andThen(fire(wait)),
            Effect.ensuring(forget(wait.id)),
          ),
        )
      })

    const sync = Effect.gen(function* () {
      const waits = yield* load
      yield* Effect.forEach(waits, arm, { discard: true })
    })

    const owned = (sessionID: Session.ID) =>
      load.pipe(
        Effect.map((waits) => byFiringOrder(waits.filter((w) => w.sessionID === sessionID))),
      )

    const cancel = Effect.fn("Supervisor.cancel")(function* (sessionID: Session.ID, id: WaitID) {
      const waits = yield* load
      const wait = waits.find((candidate) => candidate.id === id)
      if (wait === undefined || wait.sessionID !== sessionID) return Option.none<Wait>()
      yield* FiberMap.remove(fibers, id)
      // Only report a cancellation when this call actually owned the wait: a
      // fire racing it may already have taken and delivered the record.
      const owned = yield* claim(wait)
      yield* forget(id)
      return owned ? Option.some(wait) : Option.none<Wait>()
    })

    return {
      schedule: Effect.fn("Supervisor.schedule")(function* (input: ScheduleInput) {
        const now = yield* Clock.currentTimeMillis
        const created = yield* store
          .create({
            sessionID: input.sessionID,
            prompt: input.prompt,
            duration: input.duration,
            createdAt: now,
            firesAt: now + Duration.toMillis(input.duration),
          })
          .pipe(
            Effect.catch((error) =>
              logStoreFailure("could not persist wait")(error).pipe(
                // Fall back to an unpersisted wait rather than losing it: it
                // still fires in this process, it just will not survive a
                // restart.
                Effect.as({
                  id: `mem-${now}`,
                  attempts: 0,
                  sessionID: input.sessionID,
                  prompt: input.prompt,
                  duration: input.duration,
                  createdAt: now,
                  firesAt: now + Duration.toMillis(input.duration),
                } satisfies Wait),
              ),
            ),
          )
        yield* arm(created)
        return created
      }),
      cancel,
      cancelAll: Effect.fn("Supervisor.cancelAll")(function* (sessionID: Session.ID) {
        const waits = yield* owned(sessionID)
        const cancelled: Array<Wait> = []
        for (const wait of waits) {
          const result = yield* cancel(sessionID, wait.id)
          if (Option.isSome(result)) cancelled.push(result.value)
        }
        return cancelled
      }),
      list: owned,
      listAll: load.pipe(Effect.map(byFiringOrder)),
      sync,
    }
  })
