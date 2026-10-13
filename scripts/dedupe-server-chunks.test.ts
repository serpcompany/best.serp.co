import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chunkContent,
  dedupeServerChunks,
  planChunkDedupe,
  reExportSource
} from './dedupe-server-chunks'

const chunk = (id: number, body: string, map = 'a') =>
  `module.exports=[${id},a=>{"use strict";${body}}];\n\n//# sourceMappingURL=${map}._.js.map\n`

/**
 * A chunk as the deploy builds write it: `SENTRY_AUTH_TOKEN` turns on Turbopack's debug IDs, which
 * add a prologue line and a `//# debugId=` comment. The ID comes from the content, so copies share it.
 */
const debugIdChunk = (id: number, body: string, debugId: string, map = 'a') =>
  `;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="${debugId}")}catch(e){}}();\n` +
  `module.exports=[${id},a=>{"use strict";${body}}];\n\n//# debugId=${debugId}\n//# sourceMappingURL=${map}._.js.map\n`
const DEBUG_ID = '58f02a18-9f12-2f45-f26b-72d2c00fc65d'

describe('planChunkDedupe', () => {
  it('replaces later-named copies with the first chunk of the same content in their directory', () => {
    const plan = planChunkDedupe([
      { path: '/s/chunks/ssr/_0b.js', source: chunk(1, 'x', '_0b') },
      { path: '/s/chunks/ssr/_0a.js', source: chunk(1, 'x', '_0a') },
      { path: '/s/chunks/ssr/_0c.js', source: chunk(1, 'x', '_0c') },
      { path: '/s/chunks/ssr/_0d.js', source: chunk(2, 'x', '_0d') }
    ])
    expect(plan.map(({ canonical, path }) => [path, canonical])).toEqual([
      ['/s/chunks/ssr/_0b.js', '/s/chunks/ssr/_0a.js'],
      ['/s/chunks/ssr/_0c.js', '/s/chunks/ssr/_0a.js']
    ])
    expect(plan[0]?.bytes).toBe(Buffer.byteLength(chunk(1, 'x', '_0b')))
  })

  it('keeps copies in different directories, files that are not chunks, and different content', () => {
    expect(
      planChunkDedupe([
        { path: '/s/chunks/_0a.js', source: chunk(1, 'x') },
        { path: '/s/chunks/ssr/_0a.js', source: chunk(1, 'x') },
        { path: '/s/chunks/ssr/[turbopack]_runtime.js', source: 'var RUNTIME = 1\n' },
        { path: '/s/chunks/ssr/[turbopack]_runtime2.js', source: 'var RUNTIME = 1\n' },
        { path: '/s/chunks/ssr/_0b.js', source: chunk(1, 'y') }
      ])
    ).toEqual([])
  })

  it('recognizes chunks with debug IDs and replaces copies that share content and debug ID', () => {
    const plan = planChunkDedupe([
      { path: '/s/chunks/ssr/_0a.js', source: debugIdChunk(1, 'x', DEBUG_ID, '_0a') },
      { path: '/s/chunks/ssr/_0b.js', source: debugIdChunk(1, 'x', DEBUG_ID, '_0b') },
      { path: '/s/chunks/ssr/_0c.js', source: debugIdChunk(1, 'x', 'another-debug-id', '_0c') },
      { path: '/s/chunks/ssr/_0d.js', source: chunk(1, 'x', '_0d') }
    ])
    expect(plan.map(({ canonical, path }) => [path, canonical])).toEqual([
      ['/s/chunks/ssr/_0b.js', '/s/chunks/ssr/_0a.js']
    ])
    expect(chunkContent(debugIdChunk(1, 'x', DEBUG_ID))).toContain(`//# debugId=${DEBUG_ID}`)
    expect(chunkContent('"use strict";\nmodule.exports=[1,a=>{}];\n')).toBeNull()
    expect(chunkContent(';!function(){}();\nmodule.exports=[1,a=>{}];\n')).toBeNull()
  })

  it('compares the whole chunk apart from the trailing source map comment', () => {
    expect(chunkContent(chunk(1, 'x', 'one'))).toBe(chunkContent(chunk(1, 'x', 'two')))
    expect(chunkContent(`${chunk(1, 'x')}// trailing`)).not.toBe(chunkContent(chunk(1, 'x')))
    expect(chunkContent('module.exports = require("./a.js");\n')).toBeNull()
  })
})

describe('dedupeServerChunks', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { force: true, recursive: true })
  })

  it('rewrites each copy as a re-export that loads the same module list, and is idempotent', () => {
    root = mkdtempSync(join(tmpdir(), 'dedupe-server-chunks-'))
    const ssr = join(root, 'chunks', 'ssr')
    mkdirSync(ssr, { recursive: true })
    const source = chunk(7, 'a.v=()=>"seven"', 'one')
    writeFileSync(join(ssr, '[root-of-the-server]__0a._.js'), source)
    writeFileSync(join(ssr, '_1b._.js'), chunk(7, 'a.v=()=>"seven"', 'two'))
    writeFileSync(join(ssr, '_2c._.js'), chunk(8, 'a.v=()=>"eight"'))

    const replaced = dedupeServerChunks(root)
    expect(replaced.map(({ path }) => path)).toEqual([join(ssr, '_1b._.js')])
    expect(readFileSync(join(ssr, '_1b._.js'), 'utf8')).toBe(
      reExportSource('[root-of-the-server]__0a._.js')
    )
    expect(readFileSync(join(ssr, '[root-of-the-server]__0a._.js'), 'utf8')).toBe(source)

    const require = createRequire(join(ssr, 'index.js'))
    const copy = require('./_1b._.js')
    expect(copy).toBe(require('./[root-of-the-server]__0a._.js'))
    expect(copy[0]).toBe(7)

    expect(dedupeServerChunks(root)).toEqual([])
  })

  it('dedupes a deploy build, whose chunks carry debug IDs', () => {
    root = mkdtempSync(join(tmpdir(), 'dedupe-server-chunks-'))
    const ssr = join(root, 'chunks', 'ssr')
    mkdirSync(ssr, { recursive: true })
    writeFileSync(join(ssr, '_0a._.js'), debugIdChunk(7, 'a.v=()=>"seven"', DEBUG_ID, 'one'))
    writeFileSync(join(ssr, '_0b._.js'), debugIdChunk(7, 'a.v=()=>"seven"', DEBUG_ID, 'two'))

    expect(dedupeServerChunks(root).map(({ path }) => path)).toEqual([join(ssr, '_0b._.js')])
    const require = createRequire(join(ssr, 'index.js'))
    expect(require('./_0b._.js')).toBe(require('./_0a._.js'))
    expect(require('./_0a._.js')[0]).toBe(7)
  })

  it('fails, changing nothing, when it recognizes none of the chunk files', () => {
    root = mkdtempSync(join(tmpdir(), 'dedupe-server-chunks-'))
    const ssr = join(root, 'chunks', 'ssr')
    mkdirSync(ssr, { recursive: true })
    const unknown = `/* a new chunk format */\n${chunk(7, 'a.v=()=>"seven"')}`
    writeFileSync(join(ssr, '_0a._.js'), unknown)
    writeFileSync(join(ssr, '_0b._.js'), unknown)
    writeFileSync(join(ssr, '[turbopack]_runtime.js'), 'var RUNTIME = 1\n')

    expect(() => dedupeServerChunks(root)).toThrow(/none of the 3 \.js files/u)
    expect(readFileSync(join(ssr, '_0b._.js'), 'utf8')).toBe(unknown)
  })
})
