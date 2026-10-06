import { type Database, d1ErrorCode } from './client'
import { buildGrantListingOwnerPlans, selectListingForPublicationPlan } from './listing-plans'
import {
  assertGuard,
  assertPreviousStatementChangedOne,
  type CatalogPublication,
  hoursBefore,
  listingIsLiveGuard,
  prepareCatalogPublication,
  type StatementPlan
} from './plan-support'
import type { ListingClaimMethod, ListingClaimStatus } from './schema'

/**
 * Claims of existing listings (serpcompany/best.serp.co#59, #67), the D1 side. A signed-in user
 * picks a method (`badge`, free; or `paid`, #68), proves an address on the listing's registrable
 * domain with a single-use 6-digit code, then proves the badge or pays, and becomes the listing's
 * owner (`listing_owners`, `verified_via` `badge_claim` or `paid_claim`). Every transition is a
 * compare-and-swap scoped to the claimer in SQL, so someone else's claim reads as missing and a
 * repeated or concurrent request fails instead of applying twice. The app
 * (`apps/web/lib/claims/`) validates addresses, hashes codes, sends the email, and checks the
 * badge; this module never sees a plain code.
 */

/** Wrong codes allowed per code; the fifth locks the claim for `CLAIM_LOCK_MINUTES`. */
export const CLAIM_CODE_MAX_ATTEMPTS = 5
/** The lockout after the fifth wrong code (#70: "5 attempts, 15-minute lockout"). */
export const CLAIM_LOCK_MINUTES = 15
/** Seconds before another code can be sent for the same claim. */
export const CLAIM_RESEND_COOLDOWN_SECONDS = 60
/** How long a confirmed address stays good for finishing the claim. */
export const CLAIM_VERIFIED_TTL_HOURS = 24
/** Seconds between two badge checks of one claim (as at submit, #63). */
export const CLAIM_BADGE_COOLDOWN_SECONDS = 30
/** The actor recorded on the listing log for a claim's ownership grant. */
export const CLAIM_WORKFLOW = 'claims'

export interface ClaimListing {
  id: string
  /** True while anonymous visitors can see it. */
  live: boolean
  name: string
  /** The current owner, if any (a claim is refused then). */
  ownerUserId: string | null
  slug: string
  website: string
}

export interface ListingClaim {
  attempts: number
  badgeCheckedAt: string | null
  codeExpiresAt: string
  /** True while a code waits to be entered (not used, not burned by a lockout). */
  codePending: boolean
  codeSentAt: string
  codesSent: number
  completedAt: string | null
  email: string
  emailDomain: string
  emailVerifiedAt: string | null
  id: string
  listingId: string
  lockedUntil: string | null
  method: ListingClaimMethod
  status: ListingClaimStatus
  userId: string
}

interface ClaimRow {
  attempts: number
  badge_checked_at: string | null
  code_expires_at: string
  code_pending: number
  code_sent_at: string
  codes_sent: number
  completed_at: string | null
  email: string
  email_domain: string
  email_verified_at: string | null
  id: string
  listing_id: string
  locked_until: string | null
  method: ListingClaimMethod
  status: ListingClaimStatus
  user_id: string
}

const CLAIM_COLUMNS = `c.id,c.listing_id,c.user_id,c.method,c.status,c.email,c.email_domain,
  c.code_sent_at,c.code_expires_at,c.codes_sent,c.attempts,c.locked_until,c.email_verified_at,
  c.badge_checked_at,c.completed_at,(c.code_hash IS NOT NULL) AS code_pending`

const OPEN = `c.status IN ('code_sent','email_verified')`

/** No current owner on listing `${listingSql}`. */
const ownerless = (listingSql: string) => `NOT EXISTS (SELECT 1 FROM listing_owners o
  WHERE o.listing_id=${listingSql} AND o.role='owner' AND o.revoked_at IS NULL)`

function secondsBefore(now: string, seconds: number): string {
  return hoursBefore(now, seconds / 3600)
}

/** The listing a claim targets, by slug or id, or null. */
export function selectClaimListingPlan(by: { id: string } | { slug: string }): StatementPlan {
  return {
    sql: `SELECT l.id,l.slug,l.name,l.website,
        (l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL) AS live,
        (SELECT o.user_id FROM listing_owners o WHERE o.listing_id=l.id AND o.role='owner'
          AND o.revoked_at IS NULL) AS owner_user_id
      FROM listings l WHERE ${'id' in by ? 'l.id=?' : 'l.slug=?'}`,
    params: ['id' in by ? by.id : by.slug]
  }
}

/** True when an active prohibited-URL block holds any of these keys (`url_key`). */
export function selectClaimBlockedPlan(keys: readonly string[]): StatementPlan {
  if (keys.length === 0 || keys.length > 4) throw new Error('Pass one to four block keys.')
  return {
    sql: `SELECT EXISTS (SELECT 1 FROM listing_submission_url_blocks
      WHERE lifted_at IS NULL AND url_key IN (${keys.map(() => '?').join(',')})) AS blocked`,
    params: [...keys]
  }
}

/** The claimer's own claim, by id. */
export function selectClaimPlan(input: { claimId: string; userId: string }): StatementPlan {
  return {
    sql: `SELECT ${CLAIM_COLUMNS} FROM listing_claims c WHERE c.id=? AND c.user_id=?`,
    params: [input.claimId, input.userId]
  }
}

/** The claimer's open claim of a listing, if any. */
export function selectOpenClaimPlan(input: { listingId: string; userId: string }): StatementPlan {
  return {
    sql: `SELECT ${CLAIM_COLUMNS} FROM listing_claims c
      WHERE c.listing_id=? AND c.user_id=? AND ${OPEN}`,
    params: [input.listingId, input.userId]
  }
}

export interface ClaimCodeInput {
  codeExpiresAt: string
  codeHash: string
  email: string
  emailDomain: string
  method: ListingClaimMethod
  now: string
}

/**
 * Opens a claim and records its first code, while the listing is live, ownerless, and the user
 * has no open claim of it.
 */
export function buildStartClaimPlans(
  input: ClaimCodeInput & { claimId: string; listingId: string; userId: string }
): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO listing_claims (id,listing_id,user_id,method,status,email,email_domain,
          code_hash,code_sent_at,code_expires_at,codes_sent,attempts,created_at,updated_at)
        SELECT ?,?,?,?,'code_sent',?,?,?,?,?,1,0,?,? WHERE ${listingIsLiveGuard('?')}
          AND ${ownerless('?')}`,
      params: [
        input.claimId,
        input.listingId,
        input.userId,
        input.method,
        input.email,
        input.emailDomain,
        input.codeHash,
        input.now,
        input.codeExpiresAt,
        input.now,
        input.now,
        input.listingId,
        input.listingId
      ]
    },
    assertPreviousStatementChangedOne('claim_started')
  ]
}

/**
 * Sends a new code on the user's open claim (a resend, another address, or the other method):
 * the claim goes back to `code_sent` with its attempts reset, unless a code went out less than
 * `CLAIM_RESEND_COOLDOWN_SECONDS` ago or a lockout still holds.
 */
export function buildResendClaimCodePlans(
  input: ClaimCodeInput & { claimId: string; userId: string }
): StatementPlan[] {
  const cooldown = secondsBefore(input.now, CLAIM_RESEND_COOLDOWN_SECONDS)
  return [
    {
      sql: `UPDATE listing_claims SET method=?,status='code_sent',email=?,email_domain=?,
          code_hash=?,code_sent_at=?,code_expires_at=?,codes_sent=codes_sent+1,attempts=0,
          locked_until=NULL,email_verified_at=NULL,badge_checked_at=NULL,updated_at=?
        WHERE id=? AND user_id=? AND status IN ('code_sent','email_verified')
          AND code_sent_at<=? AND (locked_until IS NULL OR locked_until<=?)
          AND ${listingIsLiveGuard('listing_claims.listing_id')}
          AND ${ownerless('listing_claims.listing_id')}`,
      params: [
        input.method,
        input.email,
        input.emailDomain,
        input.codeHash,
        input.now,
        input.codeExpiresAt,
        input.now,
        input.claimId,
        input.userId,
        cooldown,
        input.now
      ]
    },
    assertPreviousStatementChangedOne('claim_code_resent')
  ]
}

/**
 * A wrong code: one more attempt. The fifth burns the code and locks the claim until
 * `lockedUntil`; a new code can be sent after that.
 */
export function buildWrongClaimCodePlans(input: {
  claimId: string
  lockedUntil: string
  now: string
  userId: string
}): StatementPlan[] {
  const max = CLAIM_CODE_MAX_ATTEMPTS
  return [
    {
      sql: `UPDATE listing_claims SET attempts=attempts+1,
          locked_until=CASE WHEN attempts+1>=${max} THEN ? ELSE locked_until END,
          code_hash=CASE WHEN attempts+1>=${max} THEN NULL ELSE code_hash END,updated_at=?
        WHERE id=? AND user_id=? AND status='code_sent' AND code_hash IS NOT NULL
          AND attempts<${max} AND (locked_until IS NULL OR locked_until<=?)`,
      params: [input.lockedUntil, input.now, input.claimId, input.userId, input.now]
    },
    assertPreviousStatementChangedOne('claim_code_attempt_recorded')
  ]
}

/** The right code, in time: the address is confirmed and the code is spent (single use). */
export function buildConfirmClaimEmailPlans(input: {
  claimId: string
  codeHash: string
  now: string
  userId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_claims SET status='email_verified',code_hash=NULL,email_verified_at=?,
          updated_at=?
        WHERE id=? AND user_id=? AND status='code_sent' AND code_hash=? AND code_expires_at>?
          AND attempts<${CLAIM_CODE_MAX_ATTEMPTS} AND (locked_until IS NULL OR locked_until<=?)`,
      params: [
        input.now,
        input.now,
        input.claimId,
        input.userId,
        input.codeHash,
        input.now,
        input.now
      ]
    },
    assertPreviousStatementChangedOne('claim_email_confirmed')
  ]
}

/**
 * Starts one badge check of a confirmed badge claim: at most one per
 * `CLAIM_BADGE_COOLDOWN_SECONDS`, while the confirmation is fresh and the listing is still
 * live and ownerless.
 */
export function buildClaimBadgeCheckPlans(input: {
  claimId: string
  now: string
  userId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_claims SET badge_checked_at=?,updated_at=?
        WHERE id=? AND user_id=? AND status='email_verified' AND method='badge'
          AND email_verified_at>=? AND (badge_checked_at IS NULL OR badge_checked_at<=?)
          AND ${listingIsLiveGuard('listing_claims.listing_id')}
          AND ${ownerless('listing_claims.listing_id')}`,
      params: [
        input.now,
        input.now,
        input.claimId,
        input.userId,
        hoursBefore(input.now, CLAIM_VERIFIED_TTL_HOURS),
        secondsBefore(input.now, CLAIM_BADGE_COOLDOWN_SECONDS)
      ]
    },
    assertPreviousStatementChangedOne('claim_badge_check_started')
  ]
}

/**
 * Completes a confirmed claim: the claimer becomes the owner (`badge_claim` after a passing
 * badge, `paid_claim` after a payment, #68), the claim is `completed`, and every other open
 * claim of the listing is cancelled, in one batch with the catalog publication (the public
 * "Verified owner" badge changes).
 */
export function buildCompleteClaimPlans(input: {
  claimId: string
  listingId: string
  method: ListingClaimMethod
  publication: CatalogPublication
  userId: string
}): StatementPlan[] {
  const now = input.publication.now
  return [
    {
      sql: `UPDATE listing_claims SET status='completed',completed_at=?,updated_at=?
        WHERE id=? AND user_id=? AND listing_id=? AND method=? AND status='email_verified'
          AND email_verified_at>=?`,
      params: [
        now,
        now,
        input.claimId,
        input.userId,
        input.listingId,
        input.method,
        hoursBefore(now, CLAIM_VERIFIED_TTL_HOURS)
      ]
    },
    assertPreviousStatementChangedOne('claim_completed'),
    assertGuard('claim_listing_live', { sql: listingIsLiveGuard('?'), params: [input.listingId] }),
    ...buildGrantListingOwnerPlans({
      listingId: input.listingId,
      publication: input.publication,
      userId: input.userId,
      verifiedVia: input.method === 'badge' ? 'badge_claim' : 'paid_claim'
    }),
    {
      sql: `UPDATE listing_claims SET status='cancelled',code_hash=NULL,updated_at=?
        WHERE listing_id=? AND id<>? AND status IN ('code_sent','email_verified')`,
      params: [now, input.listingId, input.claimId]
    }
  ]
}

function claimOf(row: ClaimRow): ListingClaim {
  return {
    attempts: Number(row.attempts),
    badgeCheckedAt: row.badge_checked_at,
    codeExpiresAt: row.code_expires_at,
    codePending: Boolean(row.code_pending),
    codeSentAt: row.code_sent_at,
    codesSent: Number(row.codes_sent),
    completedAt: row.completed_at,
    email: row.email,
    emailDomain: row.email_domain,
    emailVerifiedAt: row.email_verified_at,
    id: row.id,
    listingId: row.listing_id,
    lockedUntil: row.locked_until,
    method: row.method,
    status: row.status,
    userId: row.user_id
  }
}

export interface ClaimOperations {
  blocked(keys: readonly string[]): Promise<boolean>
  /** The claimer's claim, by id; null for anyone else's. */
  claim(input: { claimId: string; userId: string }): Promise<ListingClaim | null>
  /** False when the cooldown, the confirmation's age, or the listing refused the check. */
  claimBadgeCheck(input: { claimId: string; now: string; userId: string }): Promise<boolean>
  /**
   * Grants ownership; false when the claim or the listing moved on. A lost publication race is
   * retried once. `actor` is recorded on the listing log.
   */
  complete(input: { actor: string; claim: ListingClaim; now: string }): Promise<boolean>
  /** False when the code was wrong, expired, spent, or the claim is locked. */
  confirmEmail(input: {
    claimId: string
    codeHash: string
    now: string
    userId: string
  }): Promise<boolean>
  listing(by: { id: string } | { slug: string }): Promise<ClaimListing | null>
  openClaim(input: { listingId: string; userId: string }): Promise<ListingClaim | null>
  recordWrongCode(input: {
    claimId: string
    lockedUntil: string
    now: string
    userId: string
  }): Promise<boolean>
  resend(input: ClaimCodeInput & { claimId: string; userId: string }): Promise<boolean>
  start(
    input: ClaimCodeInput & { claimId: string; listingId: string; userId: string }
  ): Promise<boolean>
}

export function createClaimOperations(config: { client: Database }): ClaimOperations {
  const { binding } = config.client

  async function rows<T>(plan: StatementPlan): Promise<T[]> {
    const result = await binding
      .prepare(plan.sql)
      .bind(...plan.params)
      .all<T>()
    if (!result.success) throw new Error('D1 claim query failed.')
    return result.results
  }

  /** True when the batch committed, false when a compare-and-swap (or constraint) refused it. */
  async function apply(plans: StatementPlan[]): Promise<boolean> {
    try {
      const results = await binding.batch(
        plans.map(plan => binding.prepare(plan.sql).bind(...plan.params))
      )
      if (!results.every(result => result.success)) throw new Error('D1 claim write failed.')
      return true
    } catch (error) {
      const code = d1ErrorCode(error)
      if (code.endsWith(':plan_assertion_failed') || code.endsWith(':constraint_failed')) {
        return false
      }
      throw new Error(`D1 claim write failed (${code}).`)
    }
  }

  return {
    async listing(by) {
      const [row] = await rows<{
        id: string
        live: number
        name: string
        owner_user_id: string | null
        slug: string
        website: string
      }>(selectClaimListingPlan(by))
      if (!row) return null
      return {
        id: row.id,
        live: Boolean(row.live),
        name: row.name,
        ownerUserId: row.owner_user_id,
        slug: row.slug,
        website: row.website
      }
    },

    async blocked(keys) {
      const [row] = await rows<{ blocked: number }>(selectClaimBlockedPlan(keys))
      return Boolean(row?.blocked)
    },

    async claim(input) {
      const [row] = await rows<ClaimRow>(selectClaimPlan(input))
      return row ? claimOf(row) : null
    },

    async openClaim(input) {
      const [row] = await rows<ClaimRow>(selectOpenClaimPlan(input))
      return row ? claimOf(row) : null
    },

    start: input => apply(buildStartClaimPlans(input)),
    resend: input => apply(buildResendClaimCodePlans(input)),
    recordWrongCode: input => apply(buildWrongClaimCodePlans(input)),
    confirmEmail: input => apply(buildConfirmClaimEmailPlans(input)),
    claimBadgeCheck: input => apply(buildClaimBadgeCheckPlans(input)),

    async complete({ actor, claim, now }) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [snapshot] = await rows<{
          publication_checksum: string
          slug: string
          version: number
        }>(selectListingForPublicationPlan(claim.listingId))
        if (!snapshot) return false
        const publication = await prepareCatalogPublication({
          action: 'listing-claim',
          actor,
          affectedRoutes: `/products/${snapshot.slug}/`,
          checksum: snapshot.publication_checksum,
          entityId: claim.listingId,
          now,
          version: Number(snapshot.version),
          workflow: CLAIM_WORKFLOW
        })
        const done = await apply(
          buildCompleteClaimPlans({
            claimId: claim.id,
            listingId: claim.listingId,
            method: claim.method,
            publication,
            userId: claim.userId
          })
        )
        if (done) return true
      }
      return false
    }
  }
}
