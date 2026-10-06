import { type Database, d1ErrorCode } from './client'
import {
  buildRevokeListingOwnerPlans,
  buildUnpublishListingPlans,
  selectListingForPublicationPlan
} from './listing-plans'
import {
  assertPreviousStatementChangedOne,
  hoursBefore,
  listingHasQueuedSubmission,
  prepareCatalogPublication,
  type StatementPlan
} from './plan-support'

/**
 * The D1 side of the weekly badge program (serpcompany/best.serp.co#59, #66). The Worker's
 * scheduled handler (`apps/web/lib/badge-program/program.ts`) reads the listings that are
 * due, checks their badge, and records each result here with a compare-and-swap, so two
 * overlapping runs never record (or email) the same check twice.
 *
 * **Who is checked** (`programListings`): a live listing that relies on the badge, which is
 * - a listing submitted by someone else (`source = 'submission'`) whose approved submission is
 *   on the free plan (`unpublish` branch: a confirmed miss unpublishes it), or
 * - a listing whose current owner claimed it with the badge (`verified_via = 'badge_claim'`,
 *   #67; `revoke` branch: a confirmed miss removes the owner and the listing stays up).
 * Never an admin listing without a badge claim, and never a paid listing. The listing's owner
 * must have an email address (the submitter's, for a submission), because a miss is always
 * warned before anything happens.
 *
 * **States**, all derived from `badge_checks` (`kind` says which pass wrote a row):
 * - *warning*: the listing's latest conclusive check is a `weekly` miss from the last
 *   `BADGE_WARNING_MAX_AGE_HOURS`. The weekly pass skips it; the confirmation pass rechecks it.
 *   An inconclusive recheck leaves it in warning (it is tried again the next day). A warning
 *   older than a week lapses, and the next weekly check starts over.
 * - *weekly due*: not in warning, and no check of any kind since the current cycle started.
 *   The cursor is the data itself: a recorded check (pass, miss, or inconclusive) takes the
 *   listing out of the cycle, so each run takes the next batch.
 * - *confirmation due*: in warning, the warning is old enough (`dueBefore`), and no
 *   confirmation was attempted since the current daily pass started (`attemptSince`).
 * A confirmation miss is recorded in the same batch as its unpublish (`listing-unpublish`,
 * reason `badge_missing`) or revocation (`badge_removed`), so a recorded confirmed miss always
 * has its consequence, and a lost publication race leaves nothing behind to retry from.
 */

export const BADGE_PROGRAM_ACTOR = 'badge-program'
export const BADGE_PROGRAM_WORKFLOW = 'worker-cron/badge-program'
/** A weekly miss older than this no longer counts as a warning: a new weekly check starts over. */
export const BADGE_WARNING_MAX_AGE_HOURS = 7 * 24
/** The listing activity log's reason for an unpublish after a confirmed miss. */
export const BADGE_UNPUBLISH_REASON = 'badge_missing'
/** `listing_owners.revoked_reason` (and the log's reason) after a confirmed miss. */
export const BADGE_REVOKE_REASON = 'badge_removed'

export const badgeProgramEmailTemplates = [
  'badge-missing',
  'listing-unlisted',
  'ownership-removed'
] as const
export type BadgeProgramEmailTemplate = (typeof badgeProgramEmailTemplates)[number]

/** The email ledger's event key: one email per template and check. */
export function badgeProgramEmailKey(template: BadgeProgramEmailTemplate, checkId: number): string {
  if (!Number.isSafeInteger(checkId) || checkId < 1) throw new Error('Invalid badge check id.')
  return `${template}:${checkId}`
}

export type BadgeProgramBranch = 'revoke' | 'unpublish'

export interface BadgeProgramListing {
  branch: BadgeProgramBranch
  id: string
  name: string
  ownerEmail: string
  ownerUserId: string
  slug: string
  website: string
}

export interface BadgeWarning {
  checkedAt: string
  id: number
  reason: string
}

export interface RefundCheckTarget {
  id: string
  slug: string
  website: string
}

export interface PendingConfirmation extends BadgeProgramListing {
  warning: BadgeWarning
}

/** A check result as `badge_checks` stores it; the reason is the verifier's code. */
export type BadgeCheckRecord =
  | { outcome: 'pass' }
  | { conclusive: boolean; outcome: 'fail'; reason: string }

interface EmailListing {
  id: string
  name: string
  slug: string
  website: string
}

/** An email the program sends (or sends again), keyed by template and check. */
export type BadgeProgramEmail =
  | {
      checkId: number
      checkedAt: string
      listing: EmailListing
      reason: string
      template: 'badge-missing'
      to: string
    }
  | {
      checkId: number
      checkedAt: string
      listing: EmailListing
      template: 'listing-unlisted'
      to: string
      warnedAt: string
    }
  | {
      checkId: number
      checkedAt: string
      listing: EmailListing
      template: 'ownership-removed'
      to: string
    }

/** What recording a check did: lost to another run (or a state change), or recorded. */
export type RecordedBadgeCheck =
  | { recorded: false }
  | {
      /** The email this check sends: a warning, or the consequence of a confirmed miss. */
      email: BadgeProgramEmail | null
      id: number
      /** `unpublished` or `revoked` for a confirmed miss, else `none`. */
      action: 'none' | 'revoked' | 'unpublished'
      recorded: true
    }

export interface BadgeProgramOperations {
  /** Listings in warning whose confirmation recheck is due, oldest warning first. */
  confirmationsDue(input: {
    attemptSince: string
    dueBefore: string
    limit: number
    now: string
  }): Promise<PendingConfirmation[]>
  /** Records a confirmation recheck; a conclusive miss also unpublishes or revokes. */
  recordConfirmation(input: {
    attemptSince: string
    listing: PendingConfirmation
    now: string
    result: BadgeCheckRecord
  }): Promise<RecordedBadgeCheck>
  /** Records a weekly check; a conclusive miss opens a warning. */
  recordWeekly(input: {
    cycleStart: string
    listing: BadgeProgramListing
    now: string
    result: BadgeCheckRecord
  }): Promise<RecordedBadgeCheck>
  /**
   * Records the one-off badge check of a listing being refunded (#68): `kind = 'refund'`. A
   * conclusive pass is what `buildRefundSubmissionPlans` (`keep_free`) reads to keep the listing
   * as a free one. Throws when the listing is gone or was never approved.
   */
  recordRefundCheck(input: { listingId: string; now: string; result: BadgeCheckRecord }): Promise<{
    id: number
  }>
  /** The website and slug a refund check (#68) reads, or null for an unknown listing. */
  refundCheckTarget(listingId: string): Promise<RefundCheckTarget | null>
  /** Program emails whose last send failed and that still apply, to send again. */
  retryableEmails(input: {
    limit: number
    maxAttempts: number
    now: string
  }): Promise<BadgeProgramEmail[]>
  /** Listings due for this cycle's weekly check, least recently checked first. */
  weeklyDue(input: {
    cycleStart: string
    limit: number
    now: string
  }): Promise<BadgeProgramListing[]>
}

/** The latest conclusive check of listing `l` (the warning, when it is a fresh weekly miss). */
const LATEST_CONCLUSIVE = `(SELECT c.id FROM badge_checks c WHERE c.listing_id=l.id AND c.conclusive=1
  ORDER BY c.checked_at DESC,c.id DESC LIMIT 1)`

/** The listing's approved free submission (`l.source = 'submission'` only). */
const FREE_SUBMISSION = `(SELECT s.id FROM listing_submissions s
  WHERE s.listing_id=l.id AND s.status='approved' AND s.plan='free' ORDER BY s.id LIMIT 1)`

/**
 * The owner a free submitted listing's emails go to: its current owner, or for a listing approved
 * before ownership rows existed, its submitter, unless that submitter's ownership of this listing
 * was revoked (an admin removed it; PR #106 review round 1, suggestion 5): such a listing has
 * nobody to warn, so it stays out of the program.
 */
const SUBMISSION_OWNER = (listingSql: string, submitterSql: string) => `COALESCE(
    (SELECT co.user_id FROM listing_owners co WHERE co.listing_id=${listingSql} AND co.role='owner'
      AND co.revoked_at IS NULL),
    (SELECT ${submitterSql} WHERE NOT EXISTS (SELECT 1 FROM listing_owners ro
      WHERE ro.listing_id=${listingSql} AND ro.user_id=${submitterSql}
        AND ro.revoked_at IS NOT NULL)))`

/**
 * The live listings the program checks, with their branch, owner, and warning (columns
 * `warning_*` are null unless the listing is in warning). Binds the warning cutoff, then now.
 * A free listing whose own submission is in review (`paid_pending_review`: an upgrade, or
 * `changes_requested`) waits until that decision: unpublishing is refused meanwhile, so checking
 * it would only fetch the site again every hour (round 1, suggestion 4).
 */
const PROGRAM_LISTINGS = `SELECT l.id,l.slug,l.name,l.website,
    CASE WHEN fs.id IS NULL THEN 'revoke' ELSE 'unpublish' END AS branch,
    u.id AS owner_user_id,u.email AS owner_email,
    w.id AS warning_id,w.checked_at AS warning_checked_at,w.reason AS warning_reason
  FROM listings l
  LEFT JOIN listing_submissions fs ON l.source='submission' AND fs.id=${FREE_SUBMISSION}
  LEFT JOIN listing_owners o ON o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL
  JOIN users u ON u.id=CASE WHEN fs.id IS NULL THEN o.user_id
    ELSE ${SUBMISSION_OWNER('l.id', 'fs.owner_user_id')} END
  LEFT JOIN badge_checks w ON w.id=${LATEST_CONCLUSIVE}
    AND w.kind='weekly' AND w.outcome='fail' AND w.checked_at>=?
  WHERE l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
    AND l.published_at<=? AND (fs.id IS NOT NULL OR o.verified_via='badge_claim')
    AND (fs.id IS NULL OR NOT ${listingHasQueuedSubmission('l.id')})`

const NO_CHECK_SINCE = `NOT EXISTS (SELECT 1 FROM badge_checks c
  WHERE c.listing_id=l.id AND c.checked_at>=?)`
const NO_CONFIRMATION_SINCE = `NOT EXISTS (SELECT 1 FROM badge_checks c
  WHERE c.listing_id=l.id AND c.kind='confirmation' AND c.checked_at>=?)`
const BRANCH = `CASE WHEN fs.id IS NULL THEN 'revoke' ELSE 'unpublish' END`

function warningCutoff(now: string): string {
  return hoursBefore(now, BADGE_WARNING_MAX_AGE_HOURS)
}

export function selectWeeklyDuePlan(input: {
  cycleStart: string
  limit: number
  now: string
}): StatementPlan {
  return {
    // Least recently checked first (never checked first of all), so a cycle that outgrows its
    // week carries its backlog over instead of checking the same listings again.
    sql: `${PROGRAM_LISTINGS} AND w.id IS NULL AND ${NO_CHECK_SINCE}
      ORDER BY (SELECT c.checked_at FROM badge_checks c WHERE c.listing_id=l.id
        ORDER BY c.checked_at DESC,c.id DESC LIMIT 1),l.id
      LIMIT ?`,
    params: [warningCutoff(input.now), input.now, input.cycleStart, input.limit]
  }
}

export function selectConfirmationsDuePlan(input: {
  attemptSince: string
  dueBefore: string
  limit: number
  now: string
}): StatementPlan {
  return {
    sql: `${PROGRAM_LISTINGS} AND w.id IS NOT NULL AND w.checked_at<=? AND ${NO_CONFIRMATION_SINCE}
      ORDER BY w.checked_at,l.id LIMIT ?`,
    params: [warningCutoff(input.now), input.now, input.dueBefore, input.attemptSince, input.limit]
  }
}

function checkValues(result: BadgeCheckRecord): [string, string | null, number] {
  if (result.outcome === 'pass') return ['pass', null, 1]
  if (!result.reason.trim()) throw new Error('A failed badge check needs a reason.')
  return ['fail', result.reason, result.conclusive ? 1 : 0]
}

/**
 * Records a weekly check while the listing is still in the program, not in warning, and not yet
 * checked this cycle; otherwise the batch fails (another run recorded it, or the listing left).
 */
export function buildRecordWeeklyCheckPlans(input: {
  cycleStart: string
  listingId: string
  now: string
  result: BadgeCheckRecord
}): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive,kind)
        SELECT ?,?,?,?,?,'weekly' WHERE EXISTS (${PROGRAM_LISTINGS} AND l.id=? AND w.id IS NULL
          AND ${NO_CHECK_SINCE})
        RETURNING id`,
      params: [
        input.listingId,
        input.now,
        ...checkValues(input.result),
        warningCutoff(input.now),
        input.now,
        input.listingId,
        input.cycleStart
      ]
    },
    assertPreviousStatementChangedOne('badge_weekly_check_recorded')
  ]
}

/**
 * Records a confirmation recheck while the listing is still in the program on the same branch
 * and in the same warning, and no recheck was attempted since `attemptSince`.
 */
export function buildRecordConfirmationPlans(input: {
  attemptSince: string
  branch: BadgeProgramBranch
  listingId: string
  now: string
  result: BadgeCheckRecord
  warningId: number
}): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive,kind)
        SELECT ?,?,?,?,?,'confirmation' WHERE EXISTS (${PROGRAM_LISTINGS} AND l.id=? AND w.id=?
          AND ${BRANCH}=? AND ${NO_CONFIRMATION_SINCE})
        RETURNING id`,
      params: [
        input.listingId,
        input.now,
        ...checkValues(input.result),
        warningCutoff(input.now),
        input.now,
        input.listingId,
        input.warningId,
        input.branch,
        input.attemptSince
      ]
    },
    assertPreviousStatementChangedOne('badge_confirmation_recorded')
  ]
}

/**
 * Records the refund check (#68) of an approved listing, live or not, whatever its plan: the
 * refund decides from it, and the badge program's own states ignore `refund` rows except as a
 * check of this cycle.
 */
export function buildRecordRefundCheckPlans(input: {
  listingId: string
  now: string
  result: BadgeCheckRecord
}): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive,kind)
        SELECT ?,?,?,?,?,'refund' WHERE EXISTS (SELECT 1 FROM listings
          WHERE id=? AND status='approved' AND published_at IS NOT NULL)
        RETURNING id`,
      params: [input.listingId, input.now, ...checkValues(input.result), input.listingId]
    },
    assertPreviousStatementChangedOne('badge_refund_check_recorded')
  ]
}

export function selectRefundCheckTargetPlan(listingId: string): StatementPlan {
  return {
    sql: `SELECT id,slug,website FROM listings
      WHERE id=? AND status='approved' AND published_at IS NOT NULL`,
    params: [listingId]
  }
}

interface ProgramRow {
  branch: string
  id: string
  name: string
  owner_email: string
  owner_user_id: string
  slug: string
  warning_checked_at: string | null
  warning_id: number | null
  warning_reason: string | null
  website: string
}

function branchOf(value: string): BadgeProgramBranch {
  if (value !== 'revoke' && value !== 'unpublish') {
    throw new Error('D1 returned an invalid badge program branch.')
  }
  return value
}

function listingOf(row: ProgramRow): BadgeProgramListing {
  return {
    branch: branchOf(row.branch),
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    ownerUserId: row.owner_user_id,
    slug: row.slug,
    website: row.website
  }
}

function emailListing(listing: EmailListing): EmailListing {
  return { id: listing.id, name: listing.name, slug: listing.slug, website: listing.website }
}

interface PublicationRow {
  publication_checksum: string
  slug: string
  version: number
}

interface RetryRow {
  check_id: number
  id: string
  checked_at: string
  event_key: string
  name: string
  owner_email: string
  reason: string | null
  slug: string
  warned_at: string | null
  website: string
}

export function createBadgeProgramOperations(config: { client: Database }): BadgeProgramOperations {
  const { binding } = config.client

  async function rows<T>(plan: StatementPlan): Promise<T[]> {
    const result = await binding
      .prepare(plan.sql)
      .bind(...plan.params)
      .all<T>()
    if (!result.success) throw new Error('D1 badge program query failed.')
    return result.results
  }

  /**
   * The id the batch's first statement inserted, or null when a compare-and-swap lost (another
   * run, or the listing moved on). Any other D1 failure is rethrown, so an outage fails the run
   * instead of looking like nothing was due.
   */
  async function insert(plans: StatementPlan[]): Promise<number | null> {
    let results: D1Result<{ id: number }>[]
    try {
      results = await binding.batch<{ id: number }>(
        plans.map(plan => binding.prepare(plan.sql).bind(...plan.params))
      )
    } catch (error) {
      if (d1ErrorCode(error).endsWith(':plan_assertion_failed')) return null
      throw new Error(`D1 badge program write failed (${d1ErrorCode(error)}).`)
    }
    const id = Number(results[0]?.results?.[0]?.id)
    if (!results.every(result => result.success) || !Number.isSafeInteger(id)) {
      throw new Error('D1 badge program write failed.')
    }
    return id
  }

  async function publication(listingId: string, action: string, now: string) {
    const [snapshot] = await rows<PublicationRow>(selectListingForPublicationPlan(listingId))
    if (!snapshot) return null
    return prepareCatalogPublication({
      action,
      actor: BADGE_PROGRAM_ACTOR,
      affectedRoutes: `/products/${snapshot.slug}/`,
      checksum: snapshot.publication_checksum,
      entityId: listingId,
      now,
      version: Number(snapshot.version),
      workflow: BADGE_PROGRAM_WORKFLOW
    })
  }

  /** A confirmed miss and its consequence in one batch; one retry after a publication race. */
  async function confirmMiss(
    input: Parameters<BadgeProgramOperations['recordConfirmation']>[0],
    record: StatementPlan[]
  ): Promise<number | null> {
    const { listing, now } = input
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const action = listing.branch === 'unpublish' ? 'listing-unpublish' : 'listing-owner-revoke'
      const prepared = await publication(listing.id, action, now)
      if (!prepared) return null
      const consequence =
        listing.branch === 'unpublish'
          ? buildUnpublishListingPlans({
              listingId: listing.id,
              publication: prepared,
              reason: BADGE_UNPUBLISH_REASON
            })
          : buildRevokeListingOwnerPlans({
              listingId: listing.id,
              publication: prepared,
              reason: BADGE_REVOKE_REASON,
              userId: listing.ownerUserId
            })
      const id = await insert([...record, ...consequence])
      if (id !== null) return id
    }
    return null
  }

  return {
    async weeklyDue(input) {
      return (await rows<ProgramRow>(selectWeeklyDuePlan(input))).map(listingOf)
    },

    async confirmationsDue(input) {
      return (await rows<ProgramRow>(selectConfirmationsDuePlan(input))).map(row => {
        if (row.warning_id === null || !row.warning_checked_at || !row.warning_reason) {
          throw new Error('D1 returned a pending confirmation without its warning.')
        }
        return {
          ...listingOf(row),
          warning: {
            checkedAt: row.warning_checked_at,
            id: Number(row.warning_id),
            reason: row.warning_reason
          }
        }
      })
    },

    async recordWeekly({ cycleStart, listing, now, result }) {
      const id = await insert(
        buildRecordWeeklyCheckPlans({ cycleStart, listingId: listing.id, now, result })
      )
      if (id === null) return { recorded: false }
      const miss = result.outcome === 'fail' && result.conclusive
      return {
        action: 'none',
        email: miss
          ? {
              checkId: id,
              checkedAt: now,
              listing: emailListing(listing),
              reason: result.reason,
              template: 'badge-missing',
              to: listing.ownerEmail
            }
          : null,
        id,
        recorded: true
      }
    },

    async recordConfirmation(input) {
      const { attemptSince, listing, now, result } = input
      const record = buildRecordConfirmationPlans({
        attemptSince,
        branch: listing.branch,
        listingId: listing.id,
        now,
        result,
        warningId: listing.warning.id
      })
      if (result.outcome === 'pass' || !result.conclusive) {
        const id = await insert(record)
        return id === null
          ? { recorded: false }
          : { action: 'none', email: null, id, recorded: true }
      }
      const id = await confirmMiss(input, record)
      if (id === null) return { recorded: false }
      const common = { checkId: id, checkedAt: now, listing: emailListing(listing) }
      return listing.branch === 'unpublish'
        ? {
            action: 'unpublished',
            email: {
              ...common,
              template: 'listing-unlisted',
              to: listing.ownerEmail,
              warnedAt: listing.warning.checkedAt
            },
            id,
            recorded: true
          }
        : {
            action: 'revoked',
            email: { ...common, template: 'ownership-removed', to: listing.ownerEmail },
            id,
            recorded: true
          }
    },

    async refundCheckTarget(listingId) {
      const [row] = await rows<RefundCheckTarget>(selectRefundCheckTargetPlan(listingId))
      return row ? { id: row.id, slug: row.slug, website: row.website } : null
    },

    async recordRefundCheck(input) {
      const id = await insert(buildRecordRefundCheckPlans(input))
      if (id === null) throw new Error('The refunded listing is not an approved listing.')
      return { id }
    },

    async retryableEmails({ limit, maxAttempts, now }) {
      const cutoff = warningCutoff(now)
      const failed = `d.status='failed' AND d.attempts<?`
      // A warning still applies while it is the listing's warning (`PROGRAM_LISTINGS`).
      const warnings = await rows<RetryRow>({
        sql: `SELECT d.event_key,p.warning_id AS check_id,p.warning_checked_at AS checked_at,
            p.warning_reason AS reason,p.id,p.name,p.slug,p.website,p.owner_email,NULL AS warned_at
          FROM (${PROGRAM_LISTINGS} AND w.id IS NOT NULL) p
          JOIN email_deliveries d ON d.template_id='badge-missing'
            AND d.event_key='badge-missing:'||p.warning_id
          WHERE ${failed} ORDER BY d.updated_at,d.event_key LIMIT ?`,
        params: [cutoff, now, maxAttempts, limit]
      })
      // "Unlisted" still applies while the listing stays unpublished, to its owner.
      const unlisted = await rows<RetryRow>({
        sql: `SELECT d.event_key,c.id AS check_id,c.checked_at,NULL AS reason,
            l.id,l.name,l.slug,l.website,u.email AS owner_email,
            (SELECT wc.checked_at FROM badge_checks wc WHERE wc.listing_id=l.id
              AND wc.kind='weekly' AND wc.conclusive=1 AND wc.outcome='fail' AND wc.id<c.id
              ORDER BY wc.checked_at DESC,wc.id DESC LIMIT 1) AS warned_at
          FROM email_deliveries d
          JOIN badge_checks c ON c.id=CAST(substr(d.event_key,18) AS INTEGER)
            AND d.event_key='listing-unlisted:'||c.id
          JOIN listings l ON l.id=c.listing_id
          JOIN listing_submissions fs ON fs.id=${FREE_SUBMISSION}
          JOIN users u ON u.id=${SUBMISSION_OWNER('l.id', 'fs.owner_user_id')}
          WHERE d.template_id='listing-unlisted' AND ${failed}
            AND c.kind='confirmation' AND c.outcome='fail' AND c.conclusive=1 AND c.checked_at>=?
            AND l.status='approved' AND l.is_active=0
          ORDER BY d.updated_at,d.event_key LIMIT ?`,
        params: [maxAttempts, cutoff, limit]
      })
      // "Ownership removed" goes to the owner this check revoked, within the week.
      const revoked = await rows<RetryRow>({
        sql: `SELECT d.event_key,c.id AS check_id,c.checked_at,NULL AS reason,
            l.id,l.name,l.slug,l.website,u.email AS owner_email,NULL AS warned_at
          FROM email_deliveries d
          JOIN badge_checks c ON c.id=CAST(substr(d.event_key,19) AS INTEGER)
            AND d.event_key='ownership-removed:'||c.id
          JOIN listings l ON l.id=c.listing_id
          JOIN listing_owners o ON o.listing_id=l.id AND o.revoked_reason=?
            AND o.revoked_at=c.checked_at
          JOIN users u ON u.id=o.user_id
          WHERE d.template_id='ownership-removed' AND ${failed}
            AND c.kind='confirmation' AND c.outcome='fail' AND c.conclusive=1 AND c.checked_at>=?
          ORDER BY d.updated_at,d.event_key LIMIT ?`,
        params: [BADGE_REVOKE_REASON, maxAttempts, cutoff, limit]
      })
      const listing = (row: RetryRow) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        website: row.website
      })
      const common = (row: RetryRow) => ({
        checkId: Number(row.check_id),
        checkedAt: row.checked_at,
        listing: listing(row),
        to: row.owner_email
      })
      return [
        ...warnings.map(row => ({
          ...common(row),
          reason: row.reason ?? '',
          template: 'badge-missing' as const
        })),
        ...unlisted
          .filter(row => row.warned_at !== null)
          .map(row => ({
            ...common(row),
            template: 'listing-unlisted' as const,
            warnedAt: row.warned_at ?? ''
          })),
        ...revoked.map(row => ({ ...common(row), template: 'ownership-removed' as const }))
      ]
    }
  }
}
