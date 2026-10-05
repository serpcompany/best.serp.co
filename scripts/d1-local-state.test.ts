import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localSqlitePath } from './d1-local-guard'
import { resolveFreshD1StateRoot } from './d1-local-state'

describe('fresh local D1 state root', () => {
  it('derives the isolated state root from an explicit harness state directory', () => {
    const repositoryRoot = resolve('/workspace/repository')
    const harnessStateDirectory = resolve('/runtime/d1')
    expect(resolveFreshD1StateRoot({ harnessStateDirectory, repositoryRoot })).toBe(
      resolve(harnessStateDirectory, 'drizzle/best-serp-co')
    )
  })

  it('uses only a manifest owned by the current worktree', () => {
    const repositoryRoot = resolve('/workspace/repository')
    const d1StateDirectory = resolve('/runtime/worktree/d1')
    expect(
      resolveFreshD1StateRoot({
        manifest: { d1StateDirectory, repositoryPath: repositoryRoot },
        repositoryRoot
      })
    ).toBe(resolve(d1StateDirectory, 'drizzle/best-serp-co'))
    expect(() =>
      resolveFreshD1StateRoot({
        manifest: { d1StateDirectory, repositoryPath: resolve('/workspace/other') },
        repositoryRoot
      })
    ).toThrow(/another worktree/u)
    expect(() =>
      resolveFreshD1StateRoot({
        manifest: { repositoryPath: repositoryRoot },
        repositoryRoot
      })
    ).toThrow(/no D1 state directory/u)
  })

  it('prefers the harness state directory over a runtime manifest', () => {
    const repositoryRoot = resolve('/workspace/repository')
    expect(
      resolveFreshD1StateRoot({
        harnessStateDirectory: resolve('/runtime/harness'),
        manifest: {
          d1StateDirectory: resolve('/runtime/manifest'),
          repositoryPath: repositoryRoot
        },
        repositoryRoot
      })
    ).toBe(resolve('/runtime/harness/drizzle/best-serp-co'))
  })

  it('falls back to ignored repository-local fresh state', () => {
    const repositoryRoot = resolve('/workspace/repository')
    expect(resolveFreshD1StateRoot({ repositoryRoot })).toBe(
      resolve(repositoryRoot, '.wrangler/drizzle-state/best-serp-co')
    )
  })
})

describe('canonical local D1 database file', () => {
  // A Worker preview persists Cache API (and observability) SQLite files in the same state
  // directory; only D1's own storage may count (#81).
  it('finds the D1 database next to preview cache files and refuses ambiguity', () => {
    const root = mkdtempSync(join(tmpdir(), 'best-serp-co-local-sqlite-'))
    try {
      const d1 = join(root, 'drizzle/best-serp-co/v3/d1/miniflare-D1DatabaseObject')
      const cache = join(root, 'drizzle/best-serp-co/v3/cache/miniflare-CacheObject')
      for (const directory of [d1, cache]) mkdirSync(directory, { recursive: true })
      for (const file of [
        join(d1, 'metadata.sqlite'),
        join(d1, 'abc.sqlite'),
        join(cache, 'metadata.sqlite'),
        join(cache, 'def.sqlite')
      ]) {
        writeFileSync(file, '')
      }
      expect(localSqlitePath(root)).toBe(join(d1, 'abc.sqlite'))
      writeFileSync(join(d1, 'second.sqlite'), '')
      expect(() => localSqlitePath(root)).toThrow(/exactly one SQLite database; found 2/u)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
