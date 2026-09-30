import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const biomePathspecs = ['*.js', '*.jsx', '*.ts', '*.tsx', '*.json', '*.jsonc', '*.css']
const emptyGitTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const zeroGitRevision = /^0{40}$/

export interface CommittedDiffRange {
  base: string
  head: string
}

export function committedDiffRangeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): CommittedDiffRange | undefined {
  const hasBase = Object.hasOwn(environment, 'HARNESS_DIFF_BASE')
  const hasHead = Object.hasOwn(environment, 'HARNESS_DIFF_HEAD')
  const base = environment.HARNESS_DIFF_BASE?.trim()
  const head = environment.HARNESS_DIFF_HEAD?.trim()

  if (!hasBase && !hasHead) return undefined
  if (!base || !head) {
    throw new Error(
      'Changed-file validation requires HARNESS_DIFF_BASE and HARNESS_DIFF_HEAD together so automation cannot silently skip a pushed revision. Provide both Git revisions or unset both for local validation. See docs/HARNESS.md.'
    )
  }

  return { base: zeroGitRevision.test(base) ? emptyGitTree : base, head }
}

function gitPaths(root: string, args: string[]): string[] {
  const output = execFileSync('git', [...args, '-z', '--', ...biomePathspecs], {
    cwd: root,
    encoding: 'buffer'
  })

  return output.toString('utf8').split('\0').filter(Boolean)
}

function hasOriginMain(root: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
    cwd: root,
    stdio: 'ignore'
  })
  return result.status === 0
}

function assertGitRevision(root: string, revision: string, role: 'base' | 'head'): void {
  const result = spawnSync('git', ['cat-file', '-e', `${revision}^{object}`], {
    cwd: root,
    stdio: 'ignore'
  })

  if (result.status !== 0) {
    throw new Error(
      `Changed-file validation could not resolve the ${role} revision "${revision}", so the pushed diff cannot be proven. Fetch the complete range or provide valid HARNESS_DIFF_BASE and HARNESS_DIFF_HEAD revisions. See docs/HARNESS.md.`
    )
  }
}

export function collectChangedBiomeFiles(
  root: string,
  committedRange?: CommittedDiffRange
): string[] {
  const paths = new Set<string>()

  if (committedRange) {
    assertGitRevision(root, committedRange.base, 'base')
    assertGitRevision(root, committedRange.head, 'head')
    for (const path of gitPaths(root, [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      `${committedRange.base}..${committedRange.head}`
    ])) {
      paths.add(path)
    }
  } else if (hasOriginMain(root)) {
    for (const path of gitPaths(root, [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      'origin/main...HEAD'
    ])) {
      paths.add(path)
    }
  }

  for (const path of gitPaths(root, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])) {
    paths.add(path)
  }

  for (const path of gitPaths(root, ['ls-files', '--others', '--exclude-standard'])) {
    paths.add(path)
  }

  return [...paths].sort()
}

export function runChangedBiomeCheck(
  root = resolve('.'),
  environment: Readonly<Record<string, string | undefined>> = process.env
): void {
  const files = collectChangedBiomeFiles(root, committedDiffRangeFromEnvironment(environment))

  if (files.length === 0) {
    console.log('No Biome-supported files changed; skipping.')
    return
  }

  console.log(`Checking ${files.length} changed Biome-supported file(s).`)
  const result = spawnSync(
    'pnpm',
    ['exec', 'biome', 'check', '--no-errors-on-unmatched', ...files],
    {
      cwd: root,
      stdio: 'inherit'
    }
  )

  if (result.status !== 0) {
    process.exitCode = result.status || 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runChangedBiomeCheck()
}
