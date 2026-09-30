import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
