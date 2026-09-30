import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFreshD1StateRoot } from './d1-local-state'

describe('fresh local D1 state root', () => {
  it('derives isolated Site roots from an explicit harness state directory', () => {
    const repositoryRoot = resolve('/workspace/repository')
    const harnessStateDirectory = resolve('/runtime/d1')
    expect(
      resolveFreshD1StateRoot({
        harnessStateDirectory,
        repositoryRoot,
        siteId: 'serp.software'
      })
    ).toBe(resolve(harnessStateDirectory, 'drizzle/serp-software'))
    expect(
      resolveFreshD1StateRoot({
        harnessStateDirectory,
        repositoryRoot,
        siteId: 'pornvideodownloaders.com'
      })
    ).toBe(resolve(harnessStateDirectory, 'drizzle/pornvideodownloaders-com'))
  })

  it('uses only a manifest owned by the current worktree', () => {
    const repositoryRoot = resolve('/workspace/repository')
    const d1StateDirectory = resolve('/runtime/worktree/d1')
    expect(
      resolveFreshD1StateRoot({
        manifest: { d1StateDirectory, repositoryPath: repositoryRoot },
        repositoryRoot,
        siteId: 'serp.software'
      })
    ).toBe(resolve(d1StateDirectory, 'drizzle/serp-software'))
    expect(() =>
      resolveFreshD1StateRoot({
        manifest: { d1StateDirectory, repositoryPath: resolve('/workspace/other') },
        repositoryRoot,
        siteId: 'serp.software'
      })
    ).toThrow(/another worktree/u)
    expect(() =>
      resolveFreshD1StateRoot({
        manifest: { repositoryPath: repositoryRoot },
        repositoryRoot,
        siteId: 'serp.software'
      })
    ).toThrow(/no D1 state directory/u)
  })

  it('falls back to ignored repository-local fresh state', () => {
    const repositoryRoot = resolve('/workspace/repository')
    expect(resolveFreshD1StateRoot({ repositoryRoot, siteId: 'serp.software' })).toBe(
      resolve(repositoryRoot, '.wrangler/drizzle-state/serp-software')
    )
  })
})
