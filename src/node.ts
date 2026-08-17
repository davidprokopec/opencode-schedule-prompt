import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { FileSystem } from "./store.ts"

/**
 * The real filesystem.
 *
 * `writeNew` uses the exclusive `wx` flag so two processes allocating a wait
 * id at the same time cannot both win. `writeOver` writes to a temporary file
 * and renames, so a reader never sees a half-written record.
 */
export const fileSystem: FileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
  writeNew: async (path, contents) => {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" })
  },
  writeOver: async (path, contents) => {
    const temporary = join(
      path.slice(0, path.lastIndexOf("/") + 1),
      `.${Math.random().toString(36).slice(2)}.tmp`,
    )
    await writeFile(temporary, contents, "utf8")
    await rename(temporary, path)
  },
  remove: async (path) => {
    await rm(path)
  },
}
