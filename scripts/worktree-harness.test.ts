import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { devRuntimeManifest } from './harness/agent-runtime'
import {
  buildRuntimeManifest,
  type RuntimeManifest,
  runtimeViolations
} from './harness/worktree.ts'

function createRuntimeDirectories(manifest: RuntimeManifest): void {
  for (const directory of [
    manifest.artifactDirectory,
    manifest.browserProfileDirectory,
    manifest.buildCacheDirectory,
    manifest.d1StateDirectory,
    manifest.logDirectory,
    manifest.wranglerStateDirectory
  ]) {
    mkdirSync(directory, { recursive: true })
  }
}

describe('worktree runtime harness', () => {
  it('allocates isolated state for distinct worktree instances', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'directory-worktree-'))
    const one = buildRuntimeManifest(root, 'feature-one', 'codex/feature-one')
    const two = buildRuntimeManifest(root, 'feature-two', 'codex/feature-two')

    expect(one.d1StateDirectory).not.toBe(two.d1StateDirectory)
    expect(one.logDirectory).not.toBe(two.logDirectory)
    expect(one.browserProfileDirectory).not.toBe(two.browserProfileDirectory)
    expect(one.webUrl).not.toBe(two.webUrl)
    const collisionSafe = buildRuntimeManifest(
      root,
      'feature-one',
      'codex/feature-one',
      '2026-07-30T00:00:00.000Z',
      new Set([one.webPort])
    )
    expect(collisionSafe.webPort).not.toBe(one.webPort)
  })

  it('diagnoses missing or escaping runtime state with remediation', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'directory-worktree-'))
    const manifest = buildRuntimeManifest(root, 'safe-instance', 'codex/safe-instance')
    expect(runtimeViolations(root, null)[0]).toContain('pnpm worktree:init')

    createRuntimeDirectories(manifest)
    expect(runtimeViolations(root, manifest)).toEqual([])
    expect(
      runtimeViolations(root, { ...manifest, d1StateDirectory: resolve(root, '..', 'shared-d1') })
    ).toEqual(expect.arrayContaining(['d1 directory escapes this worktree.']))
  })
})

describe('agent:dev runtime (#316 review)', () => {
  // `agent:dev` seeds the manifest's D1 directory, which resets it: a manifest from another
  // worktree, or one whose state escapes this worktree, never reaches the seed.
  it('refuses a stale or escaping runtime manifest before seeding or serving', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'directory-worktree-'))
    const manifest = buildRuntimeManifest(root, 'safe-instance', 'codex/safe-instance')
    createRuntimeDirectories(manifest)
    const write = (value: RuntimeManifest) =>
      writeFileSync(manifest.runtimeManifestPath, JSON.stringify(value))
    mkdirSync(resolve(root, '.runtime'), { recursive: true })

    write(manifest)
    expect(devRuntimeManifest(root)).toEqual(manifest)

    const shared = resolve(root, '..', 'shared-d1')
    mkdirSync(shared, { recursive: true })
    write({ ...manifest, d1StateDirectory: shared })
    expect(() => devRuntimeManifest(root)).toThrow(/d1 directory escapes this worktree/u)

    write({ ...manifest, repositoryPath: resolve(root, '..', 'other-worktree') })
    expect(() => devRuntimeManifest(root)).toThrow(/belongs to another worktree/u)
  })
})
