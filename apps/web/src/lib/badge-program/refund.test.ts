import type { BadgeCheckRecord } from '@/db/badge-program'
import { describe, expect, it, vi } from 'vitest'
import type { BadgeVerificationResult } from '../submissions/badge-verifier'
import { checkBadgeAtRefund } from './refund'

const NOW = new Date('2026-10-06T12:00:00.000Z')

function operations(target: { id: string; slug: string; website: string } | null = null) {
  const recorded: Array<{ listingId: string; now: string; result: BadgeCheckRecord }> = []
  return {
    ops: {
      async recordRefundCheck(input: { listingId: string; now: string; result: BadgeCheckRecord }) {
        recorded.push(input)
        return { id: 42 }
      },
      async refundCheckTarget(listingId: string) {
        return target && target.id === listingId ? target : null
      }
    },
    recorded
  }
}

const paid = { id: 'lst_paid', slug: 'paid.example', website: 'https://paid.example/' }

describe('badge check at refund (#68)', () => {
  it('keeps the listing as free on a pass, and records the check as a refund check', async () => {
    const { ops, recorded } = operations(paid)
    const verify = vi.fn(async (): Promise<BadgeVerificationResult> => ({ ok: true }))
    await expect(
      checkBadgeAtRefund({ listingId: 'lst_paid', now: NOW, operations: ops, verify })
    ).resolves.toEqual({ checkId: 42, keepFree: true, record: { outcome: 'pass' } })
    expect(verify).toHaveBeenCalledWith(paid)
    expect(recorded).toEqual([
      { listingId: 'lst_paid', now: NOW.toISOString(), result: { outcome: 'pass' } }
    ])
  })

  it('unpublishes on a miss, a 4xx, or a result that cannot tell', async () => {
    for (const [result, conclusive] of [
      [{ code: 'badge_missing', ok: false }, true],
      [{ code: 'http_403', ok: false }, true],
      [{ code: 'http_503', ok: false }, false],
      [{ code: 'fetch_timeout', ok: false }, false]
    ] as Array<[BadgeVerificationResult, boolean]>) {
      const { ops } = operations(paid)
      const check = await checkBadgeAtRefund({
        listingId: 'lst_paid',
        now: NOW,
        operations: ops,
        verify: async () => result
      })
      expect(check.keepFree, JSON.stringify(result)).toBe(false)
      expect(check.record).toMatchObject({ conclusive, outcome: 'fail' })
    }
    const { ops } = operations(paid)
    const thrown = await checkBadgeAtRefund({
      listingId: 'lst_paid',
      now: NOW,
      operations: ops,
      verify: async () => {
        throw new Error('boom')
      }
    })
    expect(thrown).toMatchObject({
      keepFree: false,
      record: { conclusive: false, reason: 'verification_service_error' }
    })
  })

  it('refuses an unknown listing without checking anything', async () => {
    const { ops, recorded } = operations(null)
    const verify = vi.fn()
    await expect(
      checkBadgeAtRefund({ listingId: 'lst_gone', now: NOW, operations: ops, verify })
    ).rejects.toThrow(/not an approved listing/u)
    expect(verify).not.toHaveBeenCalled()
    expect(recorded).toEqual([])
  })
})
