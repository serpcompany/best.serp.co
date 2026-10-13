/**
 * Keeps one copy of each server chunk in the Worker script (#424). OpenNext runs this between
 * `next build` and bundling (`buildCommand` in `apps/web/open-next.config.ts`).
 *
 * Turbopack writes some server chunks several times under different names, byte for byte the same
 * apart from the trailing `//# sourceMappingURL=` comment (one copy per chunk group). OpenNext
 * bundles every chunk file into the one Worker script, so the copies made up about a third of
 * its server code, and every new isolate loaded and compiled them. This replaces each later copy
 * in a directory with a re-export of the first one (by name). Every chunk keeps its path, so the
 * Turbopack runtime and OpenNext's chunk loader find it as before, and a re-export hands them the
 * same module list the copy held: the same module ids with the same factories, which the runtime
 * installs once per id either way. The rendered pages don't change.
 *
 * The deploy builds set `SENTRY_AUTH_TOKEN`, so Sentry turns on Turbopack's debug IDs: each chunk
 * then starts with a one-line debug-ID prologue and carries a `//# debugId=` comment. A debug ID
 * is derived from the chunk's content, so the copies share it, and both lines stay in the
 * compared content.
 *
 * It edits the standalone copy of the server output, the one OpenNext bundles, and nothing else.
 * It fails when it recognizes none of the chunks, so a change in Turbopack's chunk format fails
 * the build instead of quietly shipping every copy again.
 */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { project } from './project'

/** Every Turbopack server chunk starts with its module list. */
const CHUNK_PREFIX = 'module.exports=['
/**
 * With debug IDs on, the line before the module list: an IIFE that records the chunk's debug ID
 * in `globalThis._debugIds` (`;!function(){try {…_debugIds…}catch(e){}}();`).
 */
const DEBUG_ID_PROLOGUE = /^;!function\(\)\{[^\n]*\._debugIds[^\n]*\n/u
const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=[^\n]*\n?$/u

/** The server output OpenNext bundles: `next build`'s standalone copy of `.next/server`. */
export const STANDALONE_SERVER_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  project.appDirectory,
  '.next',
  'standalone',
  project.appDirectory,
  '.next',
  'server'
)

export interface ChunkFile {
  path: string
  source: string
}

export interface ChunkReplacement {
  /** The copy, rewritten as a re-export. */
  path: string
  /** The first chunk with the same content in the same directory. */
  canonical: string
  bytes: number
}

/**
 * A chunk's content without its source map comment, or null for a file that isn't a chunk. The
 * debug-ID prologue and `//# debugId=` comment, when present, stay in it.
 */
export function chunkContent(source: string): string | null {
  const moduleList = source.slice(DEBUG_ID_PROLOGUE.exec(source)?.[0].length ?? 0)
  return moduleList.startsWith(CHUNK_PREFIX) ? source.replace(SOURCE_MAP_COMMENT, '') : null
}

/** The copies to replace: each chunk whose content an earlier-named chunk in its directory has. */
export function planChunkDedupe(files: readonly ChunkFile[]): ChunkReplacement[] {
  const first = new Map<string, string>()
  const replacements: ChunkReplacement[] = []
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const content = chunkContent(file.source)
    if (content === null) continue
    const key = `${dirname(file.path)}\0${content}`
    const canonical = first.get(key)
    if (canonical === undefined) first.set(key, file.path)
    else replacements.push({ bytes: Buffer.byteLength(file.source), canonical, path: file.path })
  }
  return replacements
}

/** The re-export that replaces a copy; both files are in one directory. */
export function reExportSource(canonical: string): string {
  return `module.exports = require(${JSON.stringify(`./${basename(canonical)}`)});\n`
}

function chunkFiles(directory: string): ChunkFile[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return chunkFiles(path)
    return name.endsWith('.js') ? [{ path, source: readFileSync(path, 'utf8') }] : []
  })
}

/**
 * Rewrites the copies under `<serverDirectory>/chunks`; returns what it replaced. Throws, before
 * changing anything, when none of the `.js` files there is a chunk it recognizes.
 */
export function dedupeServerChunks(serverDirectory: string): ChunkReplacement[] {
  const files = chunkFiles(join(serverDirectory, 'chunks'))
  if (!files.some(({ source }) => chunkContent(source) !== null)) {
    throw new Error(
      `dedupe-server-chunks: none of the ${files.length} .js files under ${join(serverDirectory, 'chunks')} is a Turbopack chunk it recognizes; has the chunk format changed?`
    )
  }
  const replacements = planChunkDedupe(files)
  for (const { canonical, path } of replacements) {
    // A new file, not a write through: the standalone output may hard-link `.next/server`.
    unlinkSync(path)
    writeFileSync(path, reExportSource(canonical))
  }
  return replacements
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const replaced = dedupeServerChunks(STANDALONE_SERVER_DIRECTORY)
  const bytes = replaced.reduce((sum, { bytes }) => sum + bytes, 0)
  console.log(
    `Server chunks: ${replaced.length} duplicate copies replaced by re-exports (${(bytes / 1048576).toFixed(1)} MiB).`
  )
}
