import type { Session } from "@opencode-ai/schema/session"
import { Clock, Context, Duration, Effect, FiberMap, Layer, Option, Ref, type Scope } from "effect"
import * as Delivery from "./delivery.ts"
import type { Wait, WaitID } from "./domain.ts"

export interface ScheduleInput {
  readonly sessionID: Session.ID
  readonly prompt: string
  readonly duration: Duration.Duration
}

export interface Interface {
  /** Accepts a prompt now and delivers it once `duration` has elapsed. */
  readonly schedule: (input: ScheduleInput) => Effect.Effect<Wait>
  /** Drops a pending wait. Returns `none` when the id is unknown to the session. */
  readonly cancel: (sessionID: Session.ID, id: WaitID) => Effect.Effect<Option.Option<Wait>>
  /** Drops every wait pending for the session, in firing order. */
  readonly cancelAll: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Wait>>
  /** Lists the waits pending for the session, in firing order. */
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Wait>>
}

export class Service extends Context.Service<Service, Interface>()("opencode-wait/Scheduler") {}

const byFiringOrder = (waits: Iterable<Wait>): ReadonlyArray<Wait> =>
  [...waits].sort((left, right) => left.firesAt - right.firesAt)

/**
 * Holds pending waits for the lifetime of the plugin scope.
 *
 * Fibers live in a `FiberMap` keyed by wait id, so cancelling a wait and
 * unloading the plugin both reduce to interrupting fibers that the scope
 * already owns.
 */
export const make: Effect.Effect<Interface, never, Delivery.Service | Scope.Scope> = Effect.gen(
  function* () {
    const delivery = yield* Delivery.Service
    const fibers = yield* FiberMap.make<WaitID>()
    const pending = yield* Ref.make(new Map<WaitID, Wait>())
    const counter = yield* Ref.make(0)

    const forget = (id: WaitID) =>
      Ref.update(pending, (waits) => {
        const next = new Map(waits)
        next.delete(id)
        return next
      })

    /**
     * Atomically takes a wait out of `pending`, or reports that someone else
     * got there first.
     *
     * Firing and cancelling both claim, so exactly one of them can win: a
     * cancel that arrives after delivery has started truthfully returns `none`
     * instead of interrupting a prompt that is already on its way.
     *
     * `sessionID` is `undefined` for the firing fiber, which owns the wait
     * regardless of session.
     */
    const claim = (id: WaitID, sessionID?: Session.ID) =>
      Ref.modify(pending, (waits) => {
        const wait = waits.get(id)
        if (wait === undefined) return [Option.none<Wait>(), waits] as const
        if (sessionID !== undefined && wait.sessionID !== sessionID) {
          return [Option.none<Wait>(), waits] as const
        }
        const next = new Map(waits)
        next.delete(id)
        return [Option.some(wait), next] as const
      })

    const sessionWaits = (sessionID: Session.ID) =>
      Effect.map(Ref.get(pending), (waits) =>
        byFiringOrder([...waits.values()].filter((wait) => wait.sessionID === sessionID)),
      )

    const schedule = Effect.fn("Scheduler.schedule")(function* (input: ScheduleInput) {
      const sequence = yield* Ref.updateAndGet(counter, (value) => value + 1)
      const now = yield* Clock.currentTimeMillis
      const wait: Wait = {
        id: `w${sequence}`,
        sessionID: input.sessionID,
        prompt: input.prompt,
        duration: input.duration,
        createdAt: now,
        firesAt: now + Duration.toMillis(input.duration),
      }

      yield* Ref.update(pending, (waits) => new Map(waits).set(wait.id, wait))
      yield* FiberMap.run(
        fibers,
        wait.id,
        Effect.gen(function* () {
          yield* Effect.sleep(wait.duration)
          // Claiming before delivery closes the window in which a cancel could
          // interrupt a prompt that has already been handed to the session.
          const claimed = yield* claim(wait.id)
          if (Option.isNone(claimed)) return
          yield* delivery.deliver(claimed.value)
        }).pipe(
          // Covers interruption while still sleeping, where nothing claimed.
          Effect.ensuring(forget(wait.id)),
        ),
      )
      return wait
    })

    const cancel = Effect.fn("Scheduler.cancel")(function* (sessionID: Session.ID, id: WaitID) {
      const claimed = yield* claim(id, sessionID)
      if (Option.isNone(claimed)) return claimed
      yield* FiberMap.remove(fibers, id)
      return claimed
    })

    const cancelAll = Effect.fn("Scheduler.cancelAll")(function* (sessionID: Session.ID) {
      const candidates = yield* sessionWaits(sessionID)
      const cancelled: Array<Wait> = []
      for (const candidate of candidates) {
        const claimed = yield* claim(candidate.id, sessionID)
        if (Option.isNone(claimed)) continue
        yield* FiberMap.remove(fibers, candidate.id)
        cancelled.push(claimed.value)
      }
      return cancelled
    })

    const list = Effect.fn("Scheduler.list")(function* (sessionID: Session.ID) {
      return yield* sessionWaits(sessionID)
    })

    return Service.of({ schedule, cancel, cancelAll, list })
  },
)

export const layer: Layer.Layer<Service, never, Delivery.Service> = Layer.effect(Service, make)
