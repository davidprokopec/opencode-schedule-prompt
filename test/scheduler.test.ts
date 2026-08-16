import { describe, expect, test } from "bun:test"
import { Session } from "@opencode-ai/schema/session"
import { Deferred, Duration, Effect, Layer, Option, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import * as Delivery from "../src/delivery.ts"
import type { Wait } from "../src/domain.ts"
import * as Scheduler from "../src/scheduler.ts"

/** A `Delivery` layer that records every delivered `Wait` into a `Ref`, so
 * deliveries can be asserted deterministically instead of poking at OpenCode. */
const testDelivery = (delivered: Ref.Ref<ReadonlyArray<Wait>>): Layer.Layer<Delivery.Service> =>
  Layer.succeed(
    Delivery.Service,
    Delivery.Service.of({
      deliver: (wait) => Ref.update(delivered, (waits) => [...waits, wait]),
    }),
  )

/** Builds a scheduler wired to an in-memory delivery recorder inside the
 * ambient scope. The scheduler (and its pending waits) live exactly as long
 * as that scope. */
const setup = Effect.gen(function* () {
  const delivered = yield* Ref.make<ReadonlyArray<Wait>>([])
  const scheduler = yield* Scheduler.make.pipe(Effect.provide(testDelivery(delivered)))
  return { scheduler, delivered }
})

/** Runs a scoped test program against a deterministic `TestClock`. */
const run = <A>(program: Effect.Effect<A, never, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(TestClock.layer())))

describe("scheduler", () => {
  test("a wait is not delivered before its duration elapses, and fires exactly once after", () =>
    run(
      Effect.gen(function* () {
        const { scheduler, delivered } = yield* setup
        const sessionID = Session.ID.create()
        const duration = Duration.minutes(5)
        const wait = yield* scheduler.schedule({ sessionID, prompt: "go", duration })

        yield* TestClock.adjust(Duration.subtract(duration, Duration.millis(1)))
        expect(yield* Ref.get(delivered)).toEqual([])
        expect(yield* scheduler.list(sessionID)).toEqual([wait])

        yield* TestClock.adjust(Duration.millis(1))
        expect(yield* Ref.get(delivered)).toEqual([wait])

        // Advancing further must not deliver it again.
        yield* TestClock.adjust(Duration.hours(10))
        expect(yield* Ref.get(delivered)).toEqual([wait])
      }),
    ))

  test("list only returns waits for the requested session, sorted by firing time", () =>
    run(
      Effect.gen(function* () {
        const { scheduler } = yield* setup
        const sessionA = Session.ID.create()
        const sessionB = Session.ID.create()

        const late = yield* scheduler.schedule({
          sessionID: sessionA,
          prompt: "late",
          duration: Duration.minutes(30),
        })
        const other = yield* scheduler.schedule({
          sessionID: sessionB,
          prompt: "other session",
          duration: Duration.minutes(1),
        })
        const early = yield* scheduler.schedule({
          sessionID: sessionA,
          prompt: "early",
          duration: Duration.minutes(1),
        })

        const listA = yield* scheduler.list(sessionA)
        expect(listA).toEqual([early, late])
        expect(listA.map((wait) => wait.sessionID)).not.toContain(sessionB)

        const listB = yield* scheduler.list(sessionB)
        expect(listB).toEqual([other])
      }),
    ))

  test("a delivered wait is removed from list", () =>
    run(
      Effect.gen(function* () {
        const { scheduler } = yield* setup
        const sessionID = Session.ID.create()
        yield* scheduler.schedule({ sessionID, prompt: "go", duration: Duration.minutes(1) })

        expect(yield* scheduler.list(sessionID)).toHaveLength(1)

        yield* TestClock.adjust(Duration.minutes(1))

        expect(yield* scheduler.list(sessionID)).toEqual([])
      }),
    ))

  test("cancel prevents delivery, returns the wait, and removes it from list", () =>
    run(
      Effect.gen(function* () {
        const { scheduler, delivered } = yield* setup
        const sessionID = Session.ID.create()
        const wait = yield* scheduler.schedule({
          sessionID,
          prompt: "go",
          duration: Duration.minutes(1),
        })

        const cancelled = yield* scheduler.cancel(sessionID, wait.id)
        expect(cancelled).toEqual(Option.some(wait))
        expect(yield* scheduler.list(sessionID)).toEqual([])

        yield* TestClock.adjust(Duration.hours(1))
        expect(yield* Ref.get(delivered)).toEqual([])
      }),
    ))

  test("cancel with an unknown id returns none", () =>
    run(
      Effect.gen(function* () {
        const { scheduler } = yield* setup
        const sessionID = Session.ID.create()

        const cancelled = yield* scheduler.cancel(sessionID, "w999")
        expect(cancelled).toEqual(Option.none())
      }),
    ))

  test("cancel refuses to cancel a wait belonging to a different session", () =>
    run(
      Effect.gen(function* () {
        const { scheduler, delivered } = yield* setup
        const owner = Session.ID.create()
        const intruder = Session.ID.create()
        const wait = yield* scheduler.schedule({
          sessionID: owner,
          prompt: "go",
          duration: Duration.minutes(1),
        })

        const cancelled = yield* scheduler.cancel(intruder, wait.id)
        expect(cancelled).toEqual(Option.none())
        expect(yield* scheduler.list(owner)).toEqual([wait])

        yield* TestClock.adjust(Duration.minutes(1))
        expect(yield* Ref.get(delivered)).toEqual([wait])
      }),
    ))

  test("cancelAll cancels only the calling session's waits and leaves other sessions intact", () =>
    run(
      Effect.gen(function* () {
        const { scheduler, delivered } = yield* setup
        const sessionA = Session.ID.create()
        const sessionB = Session.ID.create()

        const first = yield* scheduler.schedule({
          sessionID: sessionA,
          prompt: "first",
          duration: Duration.minutes(1),
        })
        const second = yield* scheduler.schedule({
          sessionID: sessionA,
          prompt: "second",
          duration: Duration.minutes(2),
        })
        const untouched = yield* scheduler.schedule({
          sessionID: sessionB,
          prompt: "untouched",
          duration: Duration.minutes(1),
        })

        const cancelled = yield* scheduler.cancelAll(sessionA)
        expect(cancelled).toEqual([first, second])
        expect(yield* scheduler.list(sessionA)).toEqual([])
        expect(yield* scheduler.list(sessionB)).toEqual([untouched])

        yield* TestClock.adjust(Duration.minutes(2))
        expect(yield* Ref.get(delivered)).toEqual([untouched])
      }),
    ))

  test("closing the scope that built the scheduler interrupts pending waits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const delivered = yield* Ref.make<ReadonlyArray<Wait>>([])
        const sessionID = Session.ID.create()

        yield* Effect.scoped(
          Effect.gen(function* () {
            const scheduler = yield* Scheduler.make.pipe(Effect.provide(testDelivery(delivered)))
            yield* scheduler.schedule({
              sessionID,
              prompt: "go",
              duration: Duration.minutes(1),
            })
          }),
        )
        // The scope built above (and its FiberMap) is now closed.

        yield* TestClock.adjust(Duration.hours(1))
        expect(yield* Ref.get(delivered)).toEqual([])
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("a wait being delivered is no longer listed and can no longer be cancelled", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const delivered = yield* Ref.make<ReadonlyArray<Wait>>([])
        // Holds delivery open so the test can act while a prompt is in flight,
        // which is exactly the window a naive cancel would corrupt.
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const blocking = Layer.succeed(
          Delivery.Service,
          Delivery.Service.of({
            deliver: (wait) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(finish)
                yield* Ref.update(delivered, (waits) => [...waits, wait])
              }),
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const scheduler = yield* Scheduler.make.pipe(Effect.provide(blocking))
            const sessionID = Session.ID.create()
            const wait = yield* scheduler.schedule({
              sessionID,
              prompt: "go",
              duration: Duration.minutes(1),
            })

            yield* TestClock.adjust(Duration.minutes(1))
            yield* Deferred.await(started)

            expect(yield* scheduler.list(sessionID)).toEqual([])
            expect(yield* scheduler.cancel(sessionID, wait.id)).toEqual(Option.none())
            expect(yield* scheduler.cancelAll(sessionID)).toEqual([])
            expect(yield* Ref.get(delivered)).toEqual([])

            // The cancel attempts must not have interrupted the delivery.
            yield* Deferred.succeed(finish, undefined)
            yield* Effect.yieldNow
            expect(yield* Ref.get(delivered)).toEqual([wait])
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("ids are distinct across schedules", () =>
    run(
      Effect.gen(function* () {
        const { scheduler } = yield* setup
        const sessionID = Session.ID.create()

        const waits = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
          scheduler.schedule({ sessionID, prompt: "go", duration: Duration.minutes(1) }),
        )

        const ids = waits.map((wait) => wait.id)
        expect(new Set(ids).size).toBe(ids.length)
      }),
    ))
})
