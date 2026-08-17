import { describe, expect, test } from "bun:test"
import { Session } from "@opencode-ai/schema/session"
import { Duration, Effect } from "effect"
import type { Wait } from "../src/domain.ts"
import * as Store from "../src/store.ts"

const root = "/waits"

/** An `ENOENT`-shaped error, matching what `node:fs/promises` throws for a
 * missing path, so the fake behaves like the real filesystem the plugin
 * ships against (see `src/node.ts`). */
const enoent = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" })

const eexist = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" })

/** An in-memory `Store.FileSystem` fake over a `Map<string, string>`, honouring
 * the same contract as `src/node.ts`: `writeNew` is an exclusive create,
 * `claim` is an idempotent unlink that never rejects for a missing file, and
 * `remove` rejects when the file is already gone (like a bare `rm`). */
const makeMemoryFileSystem = (
  seed: Record<string, string> = {},
): { fs: Store.FileSystem; files: Map<string, string> } => {
  const files = new Map(Object.entries(seed))

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

const run = <A>(effect: Effect.Effect<A, Store.StoreError>): Promise<A> => Effect.runPromise(effect)

/** Builds `Store.create` input with sensible defaults, overridable per test. */
const makeInput = (
  overrides: Partial<Omit<Wait, "id" | "attempts">> = {},
): Omit<Wait, "id" | "attempts"> => ({
  sessionID: Session.ID.create(),
  prompt: "go",
  duration: Duration.minutes(5),
  createdAt: 0,
  firesAt: 300_000,
  ...overrides,
})

describe("Store.make / create", () => {
  test("allocates w1 then w2, and reuses w1 after it is removed", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)

    const first = await run(store.create(makeInput()))
    const second = await run(store.create(makeInput()))
    expect(first.id).toBe("w1")
    expect(second.id).toBe("w2")

    await run(store.remove(first.id))
    const third = await run(store.create(makeInput()))
    expect(third.id).toBe("w1")
  })
})

describe("Store.make round-trip", () => {
  test("create -> list preserves every field, durations compared in millis", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const input = makeInput({ prompt: "ping me", duration: Duration.hours(2), createdAt: 1_000 })

    const created = await run(store.create(input))
    const listed = await run(store.list)

    expect(listed).toHaveLength(1)
    const found = listed[0]
    if (found === undefined) throw new Error("expected the created wait to be listed")
    expect(found.id).toBe(created.id)
    expect(found.sessionID).toBe(input.sessionID)
    expect(found.prompt).toBe(input.prompt)
    expect(found.createdAt).toBe(input.createdAt)
    expect(found.firesAt).toBe(input.firesAt)
    expect(found.attempts).toBe(0)
    expect(Duration.toMillis(found.duration)).toBe(Duration.toMillis(input.duration))
  })
})

describe("Store.make list", () => {
  test("skips malformed records but returns valid ones sorted by firesAt", async () => {
    const { fs, files } = makeMemoryFileSystem({
      [`${root}/garbage.json`]: "not json{",
      [`${root}/missing-fields.json`]: JSON.stringify({ version: 1, id: "bad1" }),
      [`${root}/wrong-version.json`]: JSON.stringify({
        version: 2,
        id: "bad2",
        sessionID: Session.ID.create(),
        prompt: "nope",
        durationMs: 1_000,
        createdAt: 0,
        firesAt: 1_000,
        attempts: 0,
      }),
    })
    const store = Store.make(fs, root)

    const later = await run(store.create(makeInput({ firesAt: 900_000 })))
    const earlier = await run(store.create(makeInput({ firesAt: 100_000 })))

    // Confirm the malformed files are still on "disk" (list should skip them,
    // not silently drop them from storage).
    expect(files.size).toBe(5)

    const listed = await run(store.list)
    expect(listed.map((wait) => wait.id)).toEqual([earlier.id, later.id])
  })
})

describe("Store.make claim", () => {
  test("returns true exactly once per id, false for an unknown id", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const wait = await run(store.create(makeInput()))

    expect(await run(store.claim(wait.id))).toBe(true)
    expect(await run(store.claim(wait.id))).toBe(false)
    expect(await run(store.claim("w999"))).toBe(false)
  })
})

describe("Store.make update", () => {
  test("overwrites the record in place; changes are visible in list", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const wait = await run(store.create(makeInput({ prompt: "before", firesAt: 1_000 })))

    await run(store.update({ ...wait, prompt: "after", firesAt: 2_000 }))

    const listed = await run(store.list)
    expect(listed).toHaveLength(1)
    const found = listed[0]
    if (found === undefined) throw new Error("expected the updated wait to be listed")
    expect(found.id).toBe(wait.id)
    expect(found.prompt).toBe("after")
    expect(found.firesAt).toBe(2_000)
  })
})

describe("Store.make remove", () => {
  test("removing an already-removed id succeeds (absence is swallowed)", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)
    const wait = await run(store.create(makeInput()))

    await run(store.remove(wait.id))
    // Second removal must not fail even though the underlying fake `remove`
    // rejects for a missing path, exactly like `node:fs/promises` `rm`.
    await run(store.remove(wait.id))

    expect(await run(store.list)).toHaveLength(0)
  })

  test("removing an id that never existed also succeeds", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, root)

    await run(store.remove("w999"))
  })
})

describe("Store.nextAttempt", () => {
  const baseWait: Wait = {
    id: "w1",
    sessionID: Session.ID.create(),
    prompt: "go",
    duration: Duration.minutes(1),
    createdAt: 0,
    firesAt: 60_000,
    attempts: 0,
  }
  const now = 1_000_000

  test.each([
    [0, Duration.minutes(5)],
    [1, Duration.minutes(15)],
    [2, Duration.minutes(45)],
  ])("re-arms attempt %i at now + backoff, incrementing attempts", (attempts, delay) => {
    const retry = Store.nextAttempt({ ...baseWait, attempts }, now)
    expect(retry).toBeDefined()
    expect(retry?.attempts).toBe(attempts + 1)
    expect(retry?.firesAt).toBe(now + Duration.toMillis(delay))
  })

  test("attempt 3 (backoff exhausted) returns undefined", () => {
    expect(Store.nextAttempt({ ...baseWait, attempts: 3 }, now)).toBeUndefined()
  })
})
