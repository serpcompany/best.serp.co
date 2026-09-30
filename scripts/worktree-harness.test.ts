import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
