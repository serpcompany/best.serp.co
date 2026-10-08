import { describe, expect, it, vi } from 'vitest'
import {
  assertInteractive,
  CONFIRM_LENGTH,
  type GitResult,
  type PromoteDependencies,
  promoteStaging
} from './release-promote'
import type { StagingVerification } from './staging-verification'

const main = 'a'.repeat(40)
const staging = 'b'.repeat(40)
const ok = (stdout = ''): GitResult => ({ status: 0, stderr: '', stdout })

interface Fakes {
  ancestry?: GitResult
  answer?: string
  fetch?: GitResult
  mainSha?: string
  push?: GitResult
  verify?: () => Promise<StagingVerification>
}

/** Dependencies with fake git, GitHub, and terminal; no network or repository is touched. */
function fakes(options: Fakes = {}) {
  const calls: string[][] = []
  const git = vi.fn(async (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args])
    const [command] = args
    if (command === 'fetch') return options.fetch ?? ok()
    if (command === 'rev-parse') {
      return ok(args[2]?.includes('origin/main') ? (options.mainSha ?? main) : staging)
    }
    if (command === 'merge-base') return options.ancestry ?? ok()
    if (command === 'log') return ok('bbbbbbb feat: something (#200)')
    if (command === 'push') return options.push ?? ok()
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
  const verify = vi.fn(
    options.verify ??
      (async () => ({
        match: 'commit' as const,
        runAttempt: 1,
        runId: 7,
        runUrl: 'https://github.com/serpcompany/best.serp.co/actions/runs/7',
        sha: staging,
        stagingSha: staging,
        tree: 'c'.repeat(40)
      }))
  )
  const confirm = vi.fn(async () => options.answer ?? staging.slice(0, CONFIRM_LENGTH))
  const deps: PromoteDependencies = {
    confirm,
    git,
    log: vi.fn(),
    token: async () => 'token',
    verify
  }
  const pushes = () => calls.filter(([command]) => command === 'push')
  return { confirm, deps, pushes, verify }
}

describe('pnpm release:promote (#171)', () => {
  it('fast-forwards main to the verified staging commit after the owner confirms it', async () => {
    const { confirm, deps, pushes, verify } = fakes()
    await expect(promoteStaging(deps)).resolves.toBe('promoted')
    expect(verify).toHaveBeenCalledWith({ sha: staging, token: 'token' })
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(staging.slice(0, 12)))
    // The exact verified commit, never a ref that could move, and never forced.
    expect(pushes()).toEqual([['push', 'origin', `${staging}:refs/heads/main`]])
  })

  it('does nothing when main is already at staging', async () => {
    const { deps, pushes, verify } = fakes({ mainSha: staging })
    await expect(promoteStaging(deps)).resolves.toBe('up-to-date')
    expect(verify).not.toHaveBeenCalled()
    expect(pushes()).toEqual([])
  })

  it('refuses when main has commits staging lacks, before asking GitHub', async () => {
    const { deps, pushes, verify } = fakes({ ancestry: { status: 1, stderr: '', stdout: '' } })
    await expect(promoteStaging(deps)).rejects.toThrow(/main cannot fast-forward/u)
    expect(verify).not.toHaveBeenCalled()
    expect(pushes()).toEqual([])
  })

  it('refuses when the ancestry check itself fails', async () => {
    const { deps, pushes } = fakes({ ancestry: { status: 128, stderr: 'bad object', stdout: '' } })
    await expect(promoteStaging(deps)).rejects.toThrow(/bad object/u)
    expect(pushes()).toEqual([])
  })

  it('refuses when Deploy Staging has not verified the staging head', async () => {
    const { confirm, deps, pushes } = fakes({
      verify: async () => {
        throw new Error('No Deploy Staging attempt has completed every staging step yet.')
      }
    })
    await expect(promoteStaging(deps)).rejects.toThrow(/^Refusing: No Deploy Staging attempt/u)
    expect(confirm).not.toHaveBeenCalled()
    expect(pushes()).toEqual([])
  })

  it.each(['', 'yes', staging.slice(0, 11), staging])(
    'refuses when the confirmation is %j',
    async answer => {
      const { deps, pushes } = fakes({ answer })
      await expect(promoteStaging(deps)).rejects.toThrow(/confirmation did not match/u)
      expect(pushes()).toEqual([])
    }
  )

  it('refuses when the fetch fails', async () => {
    const { deps, pushes, verify } = fakes({
      fetch: { status: 128, stderr: 'Could not resolve host', stdout: '' }
    })
    await expect(promoteStaging(deps)).rejects.toThrow(/Could not resolve host/u)
    expect(verify).not.toHaveBeenCalled()
    expect(pushes()).toEqual([])
  })

  it('explains a rejected push', async () => {
    const { deps } = fakes({
      push: { status: 1, stderr: 'GH013: Repository rule violations found', stdout: '' }
    })
    await expect(promoteStaging(deps)).rejects.toThrow(/bypass actor/u)
  })

  it('runs only at a terminal', () => {
    expect(() => assertInteractive(undefined)).toThrow(/Agents never run it/u)
    expect(() => assertInteractive(false)).toThrow(/needs a terminal/u)
    expect(() => assertInteractive(true)).not.toThrow()
  })
})
