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
})
