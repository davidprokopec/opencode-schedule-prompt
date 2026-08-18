import { homedir } from "node:os"
import { join } from "node:path"
import type { Session } from "@opencode-ai/schema/session"
import { Duration, Effect, Schema } from "effect"
import type { Wait, WaitID } from "./domain.ts"

/**
 * On-disk record of a pending wait.
 *
 * This file format is the contract between the two halves of the plugin: the
 * TUI entrypoint creates records, the server entrypoint owns the timers and
 * deletes records once delivered. Change it only in a backwards compatible
 * way, or bump `version` and migrate.
 *
 * Named `WaitRecord` rather than `Record` so it does not shadow TypeScript's
 * `Record<K, V>` utility type in this module.
 */
export const WaitRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  sessionID: Schema.String,
  prompt: Schema.String,
  durationMs: Schema.Finite,
  createdAt: Schema.Finite,
  firesAt: Schema.Finite,
  /** Delivery attempts already made. Drives the re-arm backoff. */
  attempts: Schema.Finite,
})
export type WaitRecord = typeof WaitRecord.Type

const decodeRecord = Schema.decodeUnknownOption(WaitRecord)

export class StoreError extends Schema.TaggedError<StoreError>()("opencode2-waits/StoreError", {
  operation: Schema.String,
  path: Schema.String,
  reason: Schema.String,
}) {
  get display(): string {
    return `${this.operation} failed for ${this.path}: ${this.reason}`
  }
}

/**
 * Where pending waits live.
 *
 * A directory with one file per wait rather than a single JSON document, so
 * the TUI and the server never write the same file and cannot lose each
 * other's records.
 */
export const directory = (env: NodeJS.ProcessEnv = process.env): string => {
  const base = env.XDG_DATA_HOME?.trim()
  const root = base !== undefined && base !== "" ? base : join(homedir(), ".local", "share")
  // Keep the original directory so pending waits survive migration from the
  // previously published `opencode-waits` package.
  return join(root, "opencode-waits", "waits")
}

export const toWait = (record: WaitRecord): Wait => ({
  id: record.id,
  sessionID: record.sessionID as Session.ID,
  prompt: record.prompt,
  duration: Duration.millis(record.durationMs),
  createdAt: record.createdAt,
  firesAt: record.firesAt,
  attempts: record.attempts,
})

export const toRecord = (wait: Wait): WaitRecord => ({
  version: 1,
  id: wait.id,
  sessionID: wait.sessionID,
  prompt: wait.prompt,
  durationMs: Duration.toMillis(wait.duration),
  createdAt: wait.createdAt,
  firesAt: wait.firesAt,
  attempts: wait.attempts,
})

export const parse = (contents: string): Wait | undefined => {
  try {
    const decoded = decodeRecord(JSON.parse(contents))
    return decoded._tag === "Some" ? toWait(decoded.value) : undefined
  } catch {
    return undefined
  }
}

export const fileName = (id: WaitID): string => `${id}.json`

/** `w1`, `w2`, ... stay short enough to retype into `/wait-cancel`. */
export const nextID = (taken: ReadonlySet<string>): WaitID => {
  for (let index = 1; ; index += 1) {
    const candidate = `w${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Delay before re-arming after a failed delivery, by attempt number.
 *
 * A delivery usually fails because the provider is rate limited, which is the
 * very situation the wait was scheduled for, so it is retried a few times
 * before being given up rather than dropped immediately.
 */
export const backoff: ReadonlyArray<Duration.Duration> = [
  Duration.minutes(5),
  Duration.minutes(15),
  Duration.minutes(45),
]

/** The same wait re-armed for another try, or `undefined` once exhausted. */
export const nextAttempt = (wait: Wait, now: number): Wait | undefined => {
  const delay = backoff[wait.attempts]
  if (delay === undefined) return undefined
  return { ...wait, attempts: wait.attempts + 1, firesAt: now + Duration.toMillis(delay) }
}

const fail = (operation: string, path: string) => (cause: unknown) =>
  new StoreError({
    operation,
    path,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

/** Injected so the store can be tested without touching a real disk. */
export interface FileSystem {
  readonly mkdir: (path: string) => Promise<void>
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>
  readonly readFile: (path: string) => Promise<string>
  /** Must reject when the file already exists, so id allocation stays race free. */
  readonly writeNew: (path: string, contents: string) => Promise<void>
  readonly writeOver: (path: string, contents: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
  /** `true` when this call unlinked the file, `false` when it was already gone. */
  readonly claim: (path: string) => Promise<boolean>
}

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Wait>, StoreError>
  readonly create: (input: Omit<Wait, "id" | "attempts">) => Effect.Effect<Wait, StoreError>
  readonly update: (wait: Wait) => Effect.Effect<void, StoreError>
  readonly remove: (id: WaitID) => Effect.Effect<void, StoreError>
  /**
   * Takes exclusive ownership of a wait by removing its record.
   *
   * `true` means this call removed the file and so owns the wait; `false`
   * means it was already gone, because another process claimed it first or it
   * never existed. Unlink is atomic, so exactly one racer can get `true`.
   */
  readonly claim: (id: WaitID) => Effect.Effect<boolean, StoreError>
}

export const make = (fs: FileSystem, root: string): Interface => {
  const path = (id: WaitID) => join(root, fileName(id))

  const ensureRoot = Effect.tryPromise({ try: () => fs.mkdir(root), catch: fail("mkdir", root) })

  const entries = Effect.tryPromise({
    try: () => fs.readdir(root),
    catch: fail("readdir", root),
  }).pipe(Effect.map((found) => found.filter((entry) => entry.endsWith(".json"))))

  const write = (wait: Wait, exclusive: boolean) => {
    const contents = JSON.stringify(toRecord(wait), null, 2)
    return Effect.tryPromise({
      try: () =>
        exclusive ? fs.writeNew(path(wait.id), contents) : fs.writeOver(path(wait.id), contents),
      catch: fail(exclusive ? "writeNew" : "writeOver", path(wait.id)),
    })
  }

  return {
    list: Effect.gen(function* () {
      yield* ensureRoot
      const found = yield* entries
      const waits: Array<Wait> = []
      for (const entry of found) {
        const contents = yield* Effect.tryPromise({
          try: () => fs.readFile(join(root, entry)),
          catch: fail("readFile", join(root, entry)),
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (contents === undefined) continue
        const wait = parse(contents)
        // A malformed record is skipped rather than failing the whole listing,
        // so one bad file cannot take out every other pending wait.
        if (wait !== undefined) waits.push(wait)
      }
      return waits.sort((left, right) => left.firesAt - right.firesAt)
    }),

    create: Effect.fn("Store.create")(function* (input: Omit<Wait, "id" | "attempts">) {
      yield* ensureRoot
      // Retried because the TUI and the server can allocate concurrently;
      // `writeNew` rejects rather than clobbering an id someone else just took.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const found = yield* entries
        const taken = new Set(found.map((entry) => entry.slice(0, -".json".length)))
        const wait: Wait = { ...input, id: nextID(taken), attempts: 0 }
        const written = yield* write(wait, true).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        if (written) return wait
      }
      return yield* Effect.fail(
        new StoreError({ operation: "create", path: root, reason: "could not allocate a wait id" }),
      )
    }),

    update: (wait) => write(wait, false),

    // Already gone is the desired end state, so a missing file is not an error.
    remove: (id) =>
      Effect.tryPromise({ try: () => fs.remove(path(id)), catch: fail("remove", path(id)) }).pipe(
        Effect.orElseSucceed(() => undefined),
      ),

    claim: (id) =>
      Effect.tryPromise({ try: () => fs.claim(path(id)), catch: fail("claim", path(id)) }),
  }
}
