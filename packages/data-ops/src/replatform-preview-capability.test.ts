import { describe, expect, it } from 'vitest'
import {
  createReplatformPreviewCapability,
  resolveRehearsalRateFingerprint,
  verifyReplatformPreviewCapability
} from './replatform-preview-capability'

describe('replatform Preview capability', () => {
  it('binds a short-lived token to the exact run and slug without exposing the secret', async () => {
    const secret = 's'.repeat(32)
    const token = await createReplatformPreviewCapability({
      expiresAt: 1_000,
      runId: 'run-1',
      secret,
      slug: 'preview.example.test'
    })
    expect(token).not.toContain(secret)
    await expect(
      verifyReplatformPreviewCapability({
        now: 900,
        runId: 'run-1',
        secret,
        slug: 'preview.example.test',
        token
      })
    ).resolves.toBe(true)
    for (const changed of [
      { now: 1_001 },
      { runId: 'run-2' },
      { slug: 'other.example.test' },
      { token: `${token}x` }
    ])
      await expect(
        verifyReplatformPreviewCapability({
          now: 900,
          runId: 'run-1',
          secret,
          slug: 'preview.example.test',
          token,
          ...changed
        })
      ).resolves.toBe(false)
  })

  it('captures exactly one owned rate fingerprint and refuses concurrent unrelated rows', () => {
    expect(resolveRehearsalRateFingerprint([], ['owned'])).toBe('owned')
    const concurrent = ['owned', 'unrelated']
    expect(() => resolveRehearsalRateFingerprint([], concurrent)).toThrow('exactly one row')
    expect(concurrent).toEqual(['owned', 'unrelated'])
    expect(() => resolveRehearsalRateFingerprint(['existing'], ['existing'])).toThrow(
      'isolated empty state'
    )
  })
})
