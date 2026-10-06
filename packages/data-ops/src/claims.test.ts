import { describe, expect, it } from 'vitest'
import {
  buildClaimBadgeCheckPlans,
  buildCompleteClaimPlans,
  buildConfirmClaimEmailPlans,
  buildResendClaimCodePlans,
  buildStartClaimPlans,
  buildWrongClaimCodePlans
} from './claims'
import {
  count,
  execute,
  NOW,
  planDatabase,
  publication,
  seedLiveListing
} from './plan-test-support'

const LATER = '2026-10-06T12:05:00.000Z'
const EXPIRES = '2026-10-06T12:10:00.000Z'

function seeded() {
  const db = planDatabase()
  seedLiveListing(db, 'lst_live')
  return db
}

const start = (claimId = 'claim_1', userId = 'user_owner') =>
  buildStartClaimPlans({
    claimId,
    codeExpiresAt: EXPIRES,
    codeHash: 'hash-1',
    email: 'jo@lst_live.example',
    emailDomain: 'lst_live.example',
    listingId: 'lst_live',
    method: 'badge',
    now: NOW,
    userId
  })

const refused = (db: ReturnType<typeof planDatabase>, plans: Parameters<typeof execute>[1]) =>
  expect(() => execute(db, plans)).toThrow(/malformed JSON|constraint/u)

describe('claim plans', () => {
  it('opens one claim per user and listing, only on a live ownerless listing', () => {
    const db = seeded()
    execute(db, start())
    refused(db, start('claim_2'))
    execute(db, start('claim_3', 'user_other'))
    db.exec(`INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
      VALUES ('lst_live','user_other','admin','2026-10-01T00:00:00.000Z')`)
    db.exec("DELETE FROM listing_claims WHERE id='claim_3'")
    refused(db, start('claim_4', 'user_other'))
  })

  it('confirms only the right code in time, once, and locks after the fifth wrong one', () => {
    const db = seeded()
    execute(db, start())
    const confirm = (codeHash: string, now = LATER) =>
      buildConfirmClaimEmailPlans({ claimId: 'claim_1', codeHash, now, userId: 'user_owner' })
    refused(db, confirm('wrong'))
    refused(db, confirm('hash-1', '2026-10-06T12:10:00.000Z'))
    refused(
      db,
      buildConfirmClaimEmailPlans({
        claimId: 'claim_1',
        codeHash: 'hash-1',
        now: LATER,
        userId: 'user_other'
      })
    )
    const wrong = () =>
      buildWrongClaimCodePlans({
        claimId: 'claim_1',
        lockedUntil: '2026-10-06T12:20:00.000Z',
        now: LATER,
        userId: 'user_owner'
      })
    for (let i = 0; i < 5; i += 1) execute(db, wrong())
    refused(db, wrong())
    expect(db.prepare('SELECT attempts,code_hash,locked_until FROM listing_claims').get()).toEqual({
      attempts: 5,
      code_hash: null,
      locked_until: '2026-10-06T12:20:00.000Z'
    })
    refused(db, confirm('hash-1'))
    // A new code only after the lockout.
    const resend = (now: string) =>
      buildResendClaimCodePlans({
        claimId: 'claim_1',
        codeExpiresAt: '2026-10-06T12:31:00.000Z',
        codeHash: 'hash-2',
        email: 'jo@lst_live.example',
        emailDomain: 'lst_live.example',
        method: 'badge',
        now,
        userId: 'user_owner'
      })
    refused(db, resend('2026-10-06T12:19:00.000Z'))
    execute(db, resend('2026-10-06T12:21:00.000Z'))
    execute(
      db,
      buildConfirmClaimEmailPlans({
        claimId: 'claim_1',
        codeHash: 'hash-2',
        now: '2026-10-06T12:22:00.000Z',
        userId: 'user_owner'
      })
    )
    expect(
      db.prepare('SELECT status,code_hash,attempts,codes_sent FROM listing_claims').get()
    ).toEqual({
      attempts: 0,
      code_hash: null,
      codes_sent: 2,
      status: 'email_verified'
    })
  })

  it('completes a confirmed claim with ownership and cancels the other open claims', () => {
    const db = seeded()
    execute(db, start())
    execute(db, start('claim_2', 'user_other'))
    refused(
      db,
      buildCompleteClaimPlans({
        claimId: 'claim_1',
        listingId: 'lst_live',
        method: 'badge',
        publication: publication('listing-claim'),
        userId: 'user_owner'
      })
    )
    execute(
      db,
      buildConfirmClaimEmailPlans({
        claimId: 'claim_1',
        codeHash: 'hash-1',
        now: NOW,
        userId: 'user_owner'
      })
    )
    execute(db, buildClaimBadgeCheckPlans({ claimId: 'claim_1', now: NOW, userId: 'user_owner' }))
    refused(db, buildClaimBadgeCheckPlans({ claimId: 'claim_1', now: NOW, userId: 'user_owner' }))
    refused(
      db,
      buildCompleteClaimPlans({
        claimId: 'claim_1',
        listingId: 'lst_live',
        method: 'paid',
        publication: publication('listing-claim'),
        userId: 'user_owner'
      })
    )
    execute(
      db,
      buildCompleteClaimPlans({
        claimId: 'claim_1',
        listingId: 'lst_live',
        method: 'badge',
        publication: publication('listing-claim'),
        userId: 'user_owner'
      })
    )
    expect(db.prepare('SELECT id,status FROM listing_claims ORDER BY id').all()).toEqual([
      { id: 'claim_1', status: 'completed' },
      { id: 'claim_2', status: 'cancelled' }
    ])
    expect(db.prepare('SELECT user_id,verified_via FROM listing_owners').all()).toEqual([
      { user_id: 'user_owner', verified_via: 'badge_claim' }
    ])
    expect(count(db, 'SELECT COUNT(*) AS count FROM publication_runs')).toBe(1)
  })

  it('refuses inconsistent rows', () => {
    const db = seeded()
    execute(db, start())
    expect(() => db.exec("UPDATE listing_claims SET status='email_verified'")).toThrow(
      /CHECK constraint/u
    )
    expect(() => db.exec('UPDATE listing_claims SET attempts=6')).toThrow(/CHECK constraint/u)
    expect(() => db.exec("UPDATE listing_claims SET code_sent_at='2026-10-06 12:00:00'")).toThrow(
      /CHECK constraint/u
    )
  })
})
