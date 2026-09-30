import { afterEach, describe, expect, it } from 'vitest'
import { baseConfig, resolveDeterministicBuildId } from '../configs/next'

const managedEnvKeys = [
  'GITHUB_SHA',
  'NEXT_BUILD_ID',
  'NEXT_PUBLIC_SITE_ID',
  'SITE_ID',
  'VERCEL_GIT_COMMIT_SHA'
] as const

const originalEnv = Object.fromEntries(
  managedEnvKeys.map(key => [key, process.env[key]])
) as Record<(typeof managedEnvKeys)[number], string | undefined>

function restoreManagedEnv() {
  for (const key of managedEnvKeys) {
    const originalValue = originalEnv[key]

    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

function clearManagedEnv() {
  for (const key of managedEnvKeys) {
    delete process.env[key]
  }
}

describe('deterministic Next build id', () => {
  afterEach(() => {
    restoreManagedEnv()
  })

  it('returns a stable build id for the same site and source revision', () => {
    process.env.NEXT_BUILD_ID = 'phase-4c-source'

    expect(resolveDeterministicBuildId('serp.co')).toBe(resolveDeterministicBuildId('serp.co'))
  })

  it('separates build ids by site and source revision', () => {
    process.env.NEXT_BUILD_ID = 'phase-4c-source-a'
    const firstRevision = resolveDeterministicBuildId('serp.co')
    const otherSite = resolveDeterministicBuildId('serp.ai')

    process.env.NEXT_BUILD_ID = 'phase-4c-source-b'
    const secondRevision = resolveDeterministicBuildId('serp.co')

    expect(firstRevision).toHaveLength(20)
    expect(firstRevision).not.toBe(otherSite)
    expect(firstRevision).not.toBe(secondRevision)
  })

  it('uses explicit build, GitHub, and Vercel source revisions in order', () => {
    clearManagedEnv()
    process.env.NEXT_BUILD_ID = 'explicit-source'
    process.env.GITHUB_SHA = 'github-source'
    process.env.VERCEL_GIT_COMMIT_SHA = 'vercel-source'
    const explicitBuildId = resolveDeterministicBuildId('serp.co')

    clearManagedEnv()
    process.env.NEXT_BUILD_ID = 'github-source'
    const expectedGithubBuildId = resolveDeterministicBuildId('serp.co')

    clearManagedEnv()
    process.env.GITHUB_SHA = 'github-source'
    process.env.VERCEL_GIT_COMMIT_SHA = 'vercel-source'
    const githubBuildId = resolveDeterministicBuildId('serp.co')

    clearManagedEnv()
    process.env.NEXT_BUILD_ID = 'vercel-source'
    const expectedVercelBuildId = resolveDeterministicBuildId('serp.co')

    clearManagedEnv()
    process.env.VERCEL_GIT_COMMIT_SHA = 'vercel-source'
    const vercelBuildId = resolveDeterministicBuildId('serp.co')

    expect(explicitBuildId).not.toBe(githubBuildId)
    expect(githubBuildId).toBe(expectedGithubBuildId)
    expect(vercelBuildId).toBe(expectedVercelBuildId)
  })

  it('wires the deterministic resolver into the shared Next base config', async () => {
    clearManagedEnv()
    process.env.NEXT_BUILD_ID = 'base-config-source'
    process.env.NEXT_PUBLIC_SITE_ID = 'serp.co'

    expect(baseConfig.generateBuildId).toBeTypeOf('function')
    expect(await baseConfig.generateBuildId?.()).toBe(resolveDeterministicBuildId())
  })

  it('falls back to the repository revision or local source without randomness', () => {
    clearManagedEnv()

    const firstBuildId = resolveDeterministicBuildId('serp.co')
    const secondBuildId = resolveDeterministicBuildId('serp.co')

    expect(firstBuildId).toHaveLength(20)
    expect(firstBuildId).toBe(secondBuildId)
  })
})
