import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectChangedBiomeFiles, committedDiffRangeFromEnvironment } from './biome-changed'

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function gitOutput(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function initializeGitRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Harness Test'])
  git(root, ['config', 'user.email', 'harness@example.com'])
  return root
}

describe('changed-file Biome policy', () => {
  it('accepts only a complete committed range from automation', () => {
    expect(
      committedDiffRangeFromEnvironment({
        HARNESS_DIFF_BASE: 'before-sha',
        HARNESS_DIFF_HEAD: 'pushed-sha'
      })
    ).toEqual({ base: 'before-sha', head: 'pushed-sha' })

    expect(() => committedDiffRangeFromEnvironment({ HARNESS_DIFF_BASE: 'before-sha' })).toThrow(
      'Changed-file validation requires HARNESS_DIFF_BASE and HARNESS_DIFF_HEAD together so automation cannot silently skip a pushed revision. Provide both Git revisions or unset both for local validation. See docs/HARNESS.md.'
    )
    expect(() =>
      committedDiffRangeFromEnvironment({ HARNESS_DIFF_BASE: '', HARNESS_DIFF_HEAD: '' })
    ).toThrow('automation cannot silently skip a pushed revision')
  })

  it("maps GitHub's zero before revision to the empty tree", () => {
    expect(
      committedDiffRangeFromEnvironment({
        HARNESS_DIFF_BASE: '0000000000000000000000000000000000000000',
        HARNESS_DIFF_HEAD: 'pushed-sha'
      })
    ).toEqual({
      base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      head: 'pushed-sha'
    })
  })

  it('selects supported files committed in an explicit revision range', () => {
    const root = initializeGitRepository('biome-push-range-')

    writeFileSync(join(root, 'baseline.ts'), 'export const baseline = true\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    const base = gitOutput(root, ['rev-parse', 'HEAD'])

    writeFileSync(join(root, 'committed.ts'), 'export const pushed = true\n')
    writeFileSync(join(root, 'notes.md'), '# unsupported\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'pushed change'])
    const head = gitOutput(root, ['rev-parse', 'HEAD'])

    expect(collectChangedBiomeFiles(root, { base, head })).toEqual(['committed.ts'])
    expect(() => collectChangedBiomeFiles(root, { base: 'missing-revision', head })).toThrow(
      'the pushed diff cannot be proven'
    )
  })

  it('includes supported files committed after origin main', () => {
    const root = initializeGitRepository('biome-branch-range-')

    writeFileSync(join(root, 'baseline.ts'), 'export const baseline = true\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])

    writeFileSync(join(root, 'branch.ts'), 'export const branch = true\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'branch change'])

    expect(collectChangedBiomeFiles(root)).toEqual(['branch.ts'])
  })

  it('includes supported tracked and untracked changes but ignores unsupported files', () => {
    const root = initializeGitRepository('biome-changed-')

    writeFileSync(join(root, 'tracked.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'notes.md'), '# baseline\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])

    writeFileSync(join(root, 'tracked.ts'), 'export const value = 2\n')
    writeFileSync(join(root, 'staged.ts'), 'export const staged = true\n')
    writeFileSync(join(root, 'untracked.json'), '{"value":2}\n')
    writeFileSync(join(root, 'notes.md'), '# changed\n')
    git(root, ['add', 'staged.ts'])

    expect(collectChangedBiomeFiles(root)).toEqual(['staged.ts', 'tracked.ts', 'untracked.json'])
  })
})
