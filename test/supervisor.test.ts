import { describe, expect, test } from "bun:test"
import { Session } from "@opencode-ai/schema/session"
import { Duration, Effect, Exit, Layer, Option, Queue, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as Delivery from "../src/delivery.ts"
import type { Wait } from "../src/domain.ts"
import * as Store from "../src/store.ts"
import * as Supervisor from "../src/supervisor.ts"

const root = "/waits"

const enoent = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" })

const eexist = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" })

/** Same in-memory `Store.FileSystem` fake as `test/store.test.ts`. Kept local
 * (rather than shared) so each test file stands on its own, matching the
 * project's existing convention of self-contained test files. */
const makeMemoryFileSystem = (): { fs: Store.FileSystem; files: Map<string, string> } => {
  const files = new Map<string, string>()

  const fs: Store.FileSystem = {
    mkdir: async () => {},
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`
      const names: Array<string> = []
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (!rest.includes("/")) names.push(rest)
      }
      return names
    },
    readFile: async (path) => {
      const contents = files.get(path)
      if (contents === undefined) throw enoent(path)
      return contents
    },
    writeNew: async (path, contents) => {
      if (files.has(path)) throw eexist(path)
      files.set(path, contents)
    },
    writeOver: async (path, contents) => {
      files.set(path, contents)
    },
    remove: async (path) => {
      if (!files.has(path)) throw enoent(path)
      files.delete(path)
    },
    claim: async (path) => {
      if (!files.has(path)) return false
      files.delete(path)
      return true
    },
  }

  return { fs, files }
}

/** A recording fake `Delivery.Service`.
 *
 * `attempts` receives one entry per call to `deliver`, offered before the
 * call decides success or failure, so a test can `Queue.take` it to block
 * deterministically until a delivery was attempted — reaching that point
 * means the wait was already claimed — instead of guessing how many
 * microtask turns the fake filesystem's promises need. `delivered` only
 * records the calls that succeeded. */
const makeDelivery = () => {
  const delivered: Array<Wait> = []
  const attempts = Effect.runSync(Queue.unbounded<Wait>())
  let failNext = false

  const layer = Layer.succeed(
    Delivery.Service,
    Delivery.Service.of({
      deliver: (wait) =>
        Effect.gen(function* () {
          yield* Queue.offer(attempts, wait)
          if (failNext) {
            failNext = false
            return false
          }
          delivered.push(wait)
          return true
        }),
    }),
  )

  return {
    layer,
    delivered,
    attempts,
    /** The very next `deliver` call reports failure; every call after succeeds. */
    failNext: () => {
      failNext = true
    },
  }
}

/** A settable fake `SessionProbe` that also records every call, so a test can
 * `Queue.take` on `calls` to know `probe.exists` has run — which happens
 * strictly after the wait was claimed — without an arbitrary settle. */
const makeProbe = (initial: boolean) => {
  let alive = initial
  const calls = Effect.runSync(Queue.unbounded<Session.ID>())

  const probe: Supervisor.SessionProbe = {
    exists: (sessionID) => Queue.offer(calls, sessionID).pipe(Effect.as(alive)),
  }

  return {
    probe,
    calls,
    setAlive: (value: boolean) => {
      alive = value
    },
  }
}

/** Runs a supervisor scenario against a fresh `TestClock` and the given fake
 * `Delivery` layer, inside a single scope that is torn down (interrupting
 * every armed fiber) once the scenario effect completes. */
const runScoped = <A, E>(
  effect: Effect.Effect<A, E, Delivery.Service | Scope.Scope>,
  delivery: Layer.Layer<Delivery.Service>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(delivery), Effect.provide(TestClock.layer())),
  )

/** Drains fiber continuations that became runnable after a `TestClock.adjust`
 * but still have pending fake-filesystem promise hops to complete (e.g. the
 * re-arm path's `store.update`, which runs *after* `delivery.deliver`
 * resolves and so cannot be caught by the delivery queue). Advances no
 * virtual time and performs no real sleep; it only gives already-runnable
 * fibers repeated chances to make progress. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index += 1) {
    yield* TestClock.adjust(Duration.millis(0))
  }
})

const minutes = (value: number): number => Duration.toMillis(Duration.minutes(value))

describe("Supervisor schedule/fire", () => {
  test("nothing is delivered before the duration elapses; delivered exactly once after; the record is removed", async () => {
    const { fs, files } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    const wait = await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const wait = yield* supervisor.schedule({
          sessionID: Session.ID.create(),
          prompt: "ping",
          duration: Duration.minutes(10),
        })

        yield* TestClock.adjust(Duration.minutes(9))
        expect(delivery.delivered).toHaveLength(0)
        expect(files.has(`${root}/${wait.id}.json`)).toBe(true)

        yield* TestClock.adjust(Duration.minutes(1))
        const delivered = yield* Queue.take(delivery.attempts)
        expect(delivered.id).toBe(wait.id)

        return wait
      }),
      delivery.layer,
    )

    expect(delivery.delivered.map((w) => w.id)).toEqual([wait.id])
    expect(files.has(`${root}/${wait.id}.json`)).toBe(false)
  })

  test("duplicate-delivery regression: two supervisors sharing a store deliver one overdue record exactly once", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    await Effect.runPromise(
      Effect.gen(function* () {
        // One record, as if the TUI entrypoint wrote it while two server
        // processes (e.g. the shared service and a `--standalone` instance)
        // both watch the same store directory.
        yield* store.create({
          sessionID: Session.ID.create(),
          prompt: "ping",
          duration: Duration.minutes(10),
          createdAt: 0,
          firesAt: minutes(10),
        })

        const scopeA = yield* Scope.make()
        const scopeB = yield* Scope.make()
        const supervisorA = yield* Supervisor.make(store, probe.probe).pipe(
          Effect.provideService(Scope.Scope, scopeA),
        )
        const supervisorB = yield* Supervisor.make(store, probe.probe).pipe(
          Effect.provideService(Scope.Scope, scopeB),
        )

        yield* supervisorA.sync
        yield* supervisorB.sync

        yield* TestClock.adjust(Duration.minutes(10))
        yield* Queue.take(delivery.attempts)

        yield* Scope.close(scopeA, Exit.succeed(undefined))
        yield* Scope.close(scopeB, Exit.succeed(undefined))
      }).pipe(Effect.provide(delivery.layer), Effect.provide(TestClock.layer())),
    )

    expect(delivery.delivered).toHaveLength(1)
  })

  test("an overdue record already on disk fires as soon as sync runs", async () => {
    const { fs, files } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    await runScoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(minutes(30))
        yield* store.create({
          sessionID: Session.ID.create(),
          prompt: "overdue",
          duration: Duration.minutes(5),
          createdAt: 0,
          firesAt: minutes(5), // long before the clock's current time
        })

        const supervisor = yield* Supervisor.make(store, probe.probe)
        yield* supervisor.sync

        const delivered = yield* Queue.take(delivery.attempts)
        expect(delivered.prompt).toBe("overdue")
      }),
      delivery.layer,
    )

    expect(files.size).toBe(0)
    expect(delivery.delivered).toHaveLength(1)
  })

  test("a dead session gets no delivery and its record is removed anyway", async () => {
    const { fs, files } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(false)

    const wait = await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const wait = yield* supervisor.schedule({
          sessionID: Session.ID.create(),
          prompt: "ping",
          duration: Duration.minutes(5),
        })

        yield* TestClock.adjust(Duration.minutes(5))
        // probe.exists runs strictly after the claim, so seeing this call
        // means the record is already gone.
        yield* Queue.take(probe.calls)

        return wait
      }),
      delivery.layer,
    )

    expect(delivery.delivered).toHaveLength(0)
    expect(files.has(`${root}/${wait.id}.json`)).toBe(false)
  })

  test("a failed delivery re-arms the wait with backoff; the retry succeeds and empties the store", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const wait = yield* supervisor.schedule({
          sessionID: Session.ID.create(),
          prompt: "ping",
          duration: Duration.minutes(1),
        })

        delivery.failNext()
        yield* TestClock.adjust(Duration.minutes(1))
        yield* Queue.take(delivery.attempts)
        // The re-arm's `store.update` runs after `deliver` resolves, so wait
        // for it to land before inspecting the store.
        yield* settle

        const afterFailure = yield* store.list
        expect(afterFailure).toHaveLength(1)
        const retried = afterFailure[0]
        if (retried === undefined) throw new Error("expected the wait to still be in the store")
        expect(retried.id).toBe(wait.id)
        expect(retried.attempts).toBe(1)
        expect(retried.firesAt).toBe(minutes(1) + minutes(5))

        yield* TestClock.adjust(Duration.minutes(5))
        const redelivered = yield* Queue.take(delivery.attempts)
        expect(redelivered.id).toBe(wait.id)
        yield* settle

        expect(delivery.delivered.map((w) => w.id)).toEqual([wait.id])
        expect(yield* store.list).toHaveLength(0)
      }),
      delivery.layer,
    )
  })

  test("a wait exhausted at attempt 3 is dropped rather than re-armed, and never fires again", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    const exhausted = await Effect.runPromise(
      store
        .create({
          sessionID: Session.ID.create(),
          prompt: "ping",
          duration: Duration.minutes(1),
          createdAt: 0,
          firesAt: minutes(1),
        })
        .pipe(
          Effect.flatMap((wait) => {
            const bumped: Wait = { ...wait, attempts: 3 }
            return store.update(bumped).pipe(Effect.as(bumped))
          }),
        ),
    )

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        delivery.failNext()
        yield* supervisor.sync

        yield* TestClock.adjust(Duration.minutes(1))
        yield* Queue.take(delivery.attempts)
        yield* settle

        expect(delivery.delivered).toHaveLength(0)
        expect(yield* store.list).toHaveLength(0)

        // No further delivery, no matter how far the clock advances.
        yield* TestClock.adjust(Duration.hours(1))
        yield* settle
      }),
      delivery.layer,
    )

    expect(delivery.delivered).toHaveLength(0)
    const finalList = await Effect.runPromise(store.list)
    expect(finalList).toHaveLength(0)
    expect(exhausted.attempts).toBe(3)
  })
})

describe("Supervisor.cancel", () => {
  test("cancelling a pending wait returns it, and it never fires", async () => {
    const { fs, files } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)
    const sessionID = Session.ID.create()

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const wait = yield* supervisor.schedule({
          sessionID,
          prompt: "ping",
          duration: Duration.minutes(5),
        })

        const cancelled = yield* supervisor.cancel(sessionID, wait.id)
        expect(Option.isSome(cancelled)).toBe(true)
        expect(
          cancelled.pipe(
            Option.map((w) => w.id),
            Option.getOrNull,
          ),
        ).toBe(wait.id)
        expect(files.has(`${root}/${wait.id}.json`)).toBe(false)

        yield* TestClock.adjust(Duration.hours(1))
      }),
      delivery.layer,
    )

    expect(delivery.delivered).toHaveLength(0)
  })

  test("cancelling an unknown id returns None", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const cancelled = yield* supervisor.cancel(Session.ID.create(), "w999")
        expect(Option.isNone(cancelled)).toBe(true)
      }),
      delivery.layer,
    )
  })

  test("cancelling with the wrong sessionID returns None and the wait still fires", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)
    const owner = Session.ID.create()
    const intruder = Session.ID.create()

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const wait = yield* supervisor.schedule({
          sessionID: owner,
          prompt: "ping",
          duration: Duration.minutes(5),
        })

        const cancelled = yield* supervisor.cancel(intruder, wait.id)
        expect(Option.isNone(cancelled)).toBe(true)

        yield* TestClock.adjust(Duration.minutes(5))
        const delivered = yield* Queue.take(delivery.attempts)
        expect(delivered.id).toBe(wait.id)
      }),
      delivery.layer,
    )

    expect(delivery.delivered).toHaveLength(1)
  })
})

describe("Supervisor.sync", () => {
  test("is idempotent: calling it three times over one record still delivers exactly once", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    await Effect.runPromise(
      store.create({
        sessionID: Session.ID.create(),
        prompt: "ping",
        duration: Duration.minutes(5),
        createdAt: 0,
        firesAt: minutes(5),
      }),
    )

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        yield* supervisor.sync
        yield* supervisor.sync
        yield* supervisor.sync

        yield* TestClock.adjust(Duration.minutes(5))
        yield* Queue.take(delivery.attempts)
      }),
      delivery.layer,
    )

    expect(delivery.delivered).toHaveLength(1)
  })
})

describe("Supervisor.list / listAll", () => {
  test("list filters by session; listAll is cross-session and sorted by firesAt", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)
    const alice = Session.ID.create()
    const bob = Session.ID.create()

    await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const a1 = yield* supervisor.schedule({
          sessionID: alice,
          prompt: "a1",
          duration: Duration.minutes(10),
        })
        const b1 = yield* supervisor.schedule({
          sessionID: bob,
          prompt: "b1",
          duration: Duration.minutes(2),
        })
        const a2 = yield* supervisor.schedule({
          sessionID: alice,
          prompt: "a2",
          duration: Duration.minutes(5),
        })

        const aliceList = yield* supervisor.list(alice)
        expect(aliceList.map((w) => w.id)).toEqual([a2.id, a1.id])

        const all = yield* supervisor.listAll
        expect(all.map((w) => w.id)).toEqual([b1.id, a2.id, a1.id])
      }),
      delivery.layer,
    )
  })
})

describe("Supervisor schedule (store failure fallback)", () => {
  test("falls back to an unpersisted mem- wait when the store cannot create a record; it still fires on time", async () => {
    const { fs, files } = makeMemoryFileSystem()
    const brokenFs: Store.FileSystem = {
      ...fs,
      writeNew: async () => {
        throw new Error("disk full")
      },
    }
    const store = Store.make(brokenFs, root)
    const delivery = makeDelivery()
    const probe = makeProbe(true)

    const wait = await runScoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe.probe)
        const wait = yield* supervisor.schedule({
          sessionID: Session.ID.create(),
          prompt: "ping",
          duration: Duration.minutes(5),
        })
        expect(wait.id.startsWith("mem-")).toBe(true)
        expect(files.size).toBe(0)

        yield* TestClock.adjust(Duration.minutes(5))
        const delivered = yield* Queue.take(delivery.attempts)
        expect(delivered.id).toBe(wait.id)

        return wait
      }),
      delivery.layer,
    )

    expect(files.size).toBe(0)
    expect(delivery.delivered.map((w) => w.id)).toEqual([wait.id])
  })
})
