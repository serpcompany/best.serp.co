import { selectAdminAllowlistPlan } from './admin-plans'
import type { Database } from './client'
import { listingWebsiteConflicts } from './listing-plans'
import type { StatementPlan } from './plan-support'
import type {
  BadgeCheckOutcome,
  ListingLinkRel,
  ListingOwnerVerification,
  ListingSource,
  RejectionCategory,
  RevisionStatus,
  SubmissionPlan,
  SubmissionStatus
} from './schema'

/**
 * Reads for the admin panel (serpcompany/best.serp.co#64): the review queue, one submission or
 * revision under review, the listing search, one listing with its owner, badge checks, and
 * activity, and the category options. Every statement is a plan builder (`select…Plan`), so
 * `scripts/d1-workerd-plans.test.ts` runs each one on Wrangler-local D1, and
 * `createAdminReadOperations` maps the rows to the DTOs the admin pages render. Nothing here
 * writes; the decisions are the statement plans in `submission-plans.ts`, `revision-plans.ts`,
 * `listing-plans.ts`, and `admin-plans.ts`.
 */

/** Queue tabs: waiting for a decision, waiting on the submitter, or everything recent. */
export const reviewQueueViews = ['waiting', 'changes', 'all'] as const
export type ReviewQueueView = (typeof reviewQueueViews)[number]

const QUEUE_LIMIT = 500

const submissionStatusesByView: Record<ReviewQueueView, string> = {
  all: `'pending_badge','verified','paid_pending_review','changes_requested','approved','rejected','withdrawn'`,
  changes: `'changes_requested'`,
  waiting: `'verified','paid_pending_review'`
}

const revisionStatusesByView: Record<ReviewQueueView, string> = {
  all: `'pending_review','changes_requested','approved','rejected','withdrawn'`,
  changes: `'changes_requested'`,
  waiting: `'pending_review'`
}

/** Whether a listing is on the paid plan: a paid claim, or a paid, unrefunded submission. */
const listingPaidSql = (listingIdSql: string) => `CASE WHEN EXISTS (SELECT 1 FROM listing_owners po
    WHERE po.listing_id=${listingIdSql} AND po.revoked_at IS NULL AND po.verified_via='paid_claim')
  OR EXISTS (SELECT 1 FROM listing_submissions ps WHERE ps.listing_id=${listingIdSql}
    AND ps.plan='paid' AND ps.paid_at IS NOT NULL AND ps.refunded_at IS NULL
    AND ps.status IN ('paid_pending_review','approved'))
  THEN 'paid' ELSE 'free' END`

const latestConclusiveBadge = (listingIdSql: string) => `(SELECT outcome FROM badge_checks
  WHERE listing_id=${listingIdSql} AND conclusive=1 ORDER BY checked_at DESC,id DESC LIMIT 1)`

/**
 * Hosted copies the admin screens render instead of a source URL (#96 review S9): a
 * submission's hosted slot for its current source, or the listing's hosted logo when a revision
 * keeps it. A source with no hosted copy is shown as a link, never as an image.
 */
function submissionHostedKey(submission: string, kind: 'image' | 'logo', source?: string): string {
  return `(SELECT j.media_key FROM media_ingestions j WHERE j.submission_id=${submission}.id
    AND j.kind='${kind}' AND j.sort_order=0 AND j.status='hosted'${source ? ` AND j.source_url=${source}` : ''})`
}

function listingHostedLogoKey(listingId: string, source?: string): string {
  return `(SELECT m.media_key FROM listing_media m WHERE m.listing_id=${listingId}
    AND m.kind='logo' AND m.media_key IS NOT NULL${source ? ` AND m.url=${source}` : ''}
    ORDER BY m.sort_order LIMIT 1)`
}

/**
 * The review queue for one tab: submissions and owner revisions in one list. `queued_at` is when
 * the item entered its current state (badge verified, paid, changes requested, or edited), so
 * the age column and the default sort (oldest first) read it.
 */
export function selectReviewQueuePlan(view: ReviewQueueView): StatementPlan {
  if (!reviewQueueViews.includes(view)) throw new Error('Unknown review queue view.')
  const order = view === 'all' ? 'DESC' : 'ASC'
  return {
    sql: `SELECT * FROM (
        SELECT 'submission' AS kind,s.id,s.slug,s.name,s.website,s.logo_url,
          ${submissionHostedKey('s', 'logo', 's.logo_url')} AS logo_key,s.status,s.plan,
          s.paid_at,s.refunded_at,s.listing_id,u.email AS owner_email,
          CASE WHEN s.badge_verified_at IS NOT NULL THEN 'pass' END AS badge,
          CASE
            WHEN s.status='paid_pending_review' THEN COALESCE(s.paid_at,s.updated_at)
            WHEN s.status='verified' AND s.plan='paid' THEN COALESCE(s.paid_at,s.updated_at)
            WHEN s.status='verified' THEN COALESCE(s.badge_verified_at,s.updated_at)
            WHEN s.status='changes_requested' THEN COALESCE(s.reviewed_at,s.updated_at)
            ELSE s.updated_at
          END AS queued_at
        FROM listing_submissions s LEFT JOIN users u ON u.id=s.owner_user_id
        WHERE s.status IN (${submissionStatusesByView[view]})
        UNION ALL
        SELECT 'revision',r.id,l.slug,r.name,l.website,r.logo_url,
          ${listingHostedLogoKey('r.listing_id', 'r.logo_url')},r.status,
          ${listingPaidSql('r.listing_id')},NULL,NULL,r.listing_id,u.email,
          ${latestConclusiveBadge('r.listing_id')},
          CASE WHEN r.status='changes_requested' THEN COALESCE(r.reviewed_at,r.updated_at)
            ELSE r.updated_at END
        FROM listing_revisions r JOIN listings l ON l.id=r.listing_id
          LEFT JOIN users u ON u.id=r.author_user_id
        WHERE r.status IN (${revisionStatusesByView[view]})
      ) ORDER BY queued_at ${order},id LIMIT ${QUEUE_LIMIT}`,
    params: []
  }
}

/** Tab counts and the oldest waiting item, for the queue header and the sidebar badge. */
export function selectReviewQueueCountsPlan(): StatementPlan {
  return {
    sql: `SELECT
        (SELECT COUNT(*) FROM listing_submissions
          WHERE status IN (${submissionStatusesByView.waiting}))
        + (SELECT COUNT(*) FROM listing_revisions
          WHERE status IN (${revisionStatusesByView.waiting})) AS waiting,
        (SELECT COUNT(*) FROM listing_submissions WHERE status='changes_requested')
        + (SELECT COUNT(*) FROM listing_revisions WHERE status='changes_requested') AS changes,
        (SELECT MIN(t) FROM (
          SELECT COALESCE(CASE WHEN plan='paid' THEN paid_at ELSE badge_verified_at END,
            updated_at) AS t
          FROM listing_submissions WHERE status IN (${submissionStatusesByView.waiting})
          UNION ALL
          SELECT updated_at FROM listing_revisions
          WHERE status IN (${revisionStatusesByView.waiting}))) AS oldest_queued_at`,
    params: []
  }
}

/** The active prohibited-URL block that covers a block key, if any. */
const activeBlockColumns = (keySql: string) => `
  (SELECT b.url_key FROM listing_submission_url_blocks b
    WHERE b.url_key=${keySql} AND b.lifted_at IS NULL) AS block_url_key,
  (SELECT b.reason FROM listing_submission_url_blocks b
    WHERE b.url_key=${keySql} AND b.lifted_at IS NULL) AS block_reason,
  (SELECT b.blocked_by FROM listing_submission_url_blocks b
    WHERE b.url_key=${keySql} AND b.lifted_at IS NULL) AS block_blocked_by,
  (SELECT b.blocked_at FROM listing_submission_url_blocks b
    WHERE b.url_key=${keySql} AND b.lifted_at IS NULL) AS block_blocked_at`

/**
 * One submission under review: its staged content and decision state, the submitter, its live
 * listing (when paid and published before review), duplicates on its URL key, and the active
 * block on its key; then its resource links, FAQs, events, and the listing's badge checks.
 */
export function selectSubmissionReviewPlans(submissionId: string): StatementPlan[] {
  return [
    {
      sql: `SELECT s.id,s.slug,s.name,s.description,s.website,s.content,s.category_slug,
          c.name AS category_name,s.logo_url,s.video_url,s.status,s.plan,s.paid_at,s.refunded_at,
          ${submissionHostedKey('s', 'logo', 's.logo_url')} AS logo_key,
          ${submissionHostedKey('s', 'image')} AS image_key,
          (SELECT json_object('attempts',j.attempts,'lastError',j.last_error,
              'nextAttemptAt',j.next_attempt_at,'sourceUrl',j.source_url,'status',j.status)
            FROM media_ingestions j WHERE j.submission_id=s.id AND j.kind='image'
              AND j.sort_order=0) AS image_slot,
          s.verification_attempts,s.last_verification_at,s.last_verification_error,
          s.badge_verified_at,s.reviewed_at,s.reviewed_by,s.reviewer_note,s.rejection_reason,
          s.rejection_category,s.withdrawal_reason,s.created_at,s.updated_at,s.content_version,
          s.listing_id,s.published_checksum,COALESCE(s.block_key,s.slug) AS block_key,
          u.id AS owner_user_id,u.email AS owner_email,u.created_at AS owner_created_at,
          (SELECT COUNT(*) FROM listing_submissions o
            WHERE o.owner_user_id=s.owner_user_id AND o.id!=s.id) AS owner_other_submissions,
          l.slug AS listing_slug,l.link_rel AS listing_link_rel,l.checksum AS listing_checksum,
          CASE WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
            THEN 1 ELSE 0 END AS listing_live,
          l.published_at AS listing_published_at,
          (SELECT COUNT(*) FROM listings d WHERE d.slug=s.slug
            AND d.id IS NOT s.listing_id) AS duplicate_listings,
          (SELECT COUNT(*) FROM listing_submissions d WHERE d.slug=s.slug AND d.id!=s.id
            AND d.status IN ('draft','pending_badge','verified','paid_pending_review',
              'changes_requested')) AS duplicate_submissions,
          ${activeBlockColumns('COALESCE(s.block_key,s.slug)')}
        FROM listing_submissions s
          LEFT JOIN categories c ON c.slug=s.category_slug
          LEFT JOIN users u ON u.id=s.owner_user_id
          LEFT JOIN listings l ON l.id=s.listing_id
        WHERE s.id=?`,
      params: [submissionId]
    },
    {
      sql: `SELECT label,url,sort_order FROM listing_submission_resource_links
        WHERE submission_id=? ORDER BY sort_order`,
      params: [submissionId]
    },
    {
      sql: `SELECT question,answer,sort_order FROM listing_submission_faqs
        WHERE submission_id=? ORDER BY sort_order`,
      params: [submissionId]
    },
    {
      sql: `SELECT id,event_type,detail,actor,created_at FROM listing_submission_events
        WHERE submission_id=? ORDER BY id DESC LIMIT 50`,
      params: [submissionId]
    },
    {
      sql: `SELECT id,checked_at,outcome,reason,conclusive FROM badge_checks
        WHERE listing_id=(SELECT listing_id FROM listing_submissions WHERE id=?)
        ORDER BY checked_at DESC,id DESC LIMIT 10`,
      params: [submissionId]
    }
  ]
}

/** One owner revision under review, with the live listing it edits. */
export function selectRevisionReviewPlans(revisionId: string): StatementPlan[] {
  return [
    {
      sql: `SELECT r.id,r.listing_id,r.status,r.base_checksum,r.name,r.description,r.content,
          r.category_slug,c.name AS category_name,r.logo_url,r.video_url,r.reviewer_note,
          ${listingHostedLogoKey('r.listing_id', 'r.logo_url')} AS logo_key,
          r.rejection_reason,r.reviewed_at,r.reviewed_by,r.created_at,r.updated_at,
          r.content_version,l.slug,l.website,l.name AS listing_name,l.checksum AS listing_checksum,
          l.link_rel AS listing_link_rel,
          CASE WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
            THEN 1 ELSE 0 END AS listing_live,
          ${listingPaidSql('r.listing_id')} AS plan,
          u.id AS owner_user_id,u.email AS owner_email,u.created_at AS owner_created_at,
          (SELECT COUNT(*) FROM listing_submissions o WHERE o.owner_user_id=r.author_user_id)
            AS owner_other_submissions
        FROM listing_revisions r JOIN listings l ON l.id=r.listing_id
          LEFT JOIN categories c ON c.slug=r.category_slug
          LEFT JOIN users u ON u.id=r.author_user_id
        WHERE r.id=?`,
      params: [revisionId]
    },
    {
      sql: `SELECT label,url,sort_order FROM listing_revision_resource_links
        WHERE revision_id=? ORDER BY sort_order`,
      params: [revisionId]
    },
    {
      sql: `SELECT question,answer,sort_order FROM listing_revision_faqs
        WHERE revision_id=? ORDER BY sort_order`,
      params: [revisionId]
    },
    {
      sql: `SELECT id,event_type,detail,actor,created_at FROM listing_revision_events
        WHERE revision_id=? ORDER BY id DESC LIMIT 50`,
      params: [revisionId]
    },
    {
      sql: `SELECT id,checked_at,outcome,reason,conclusive FROM badge_checks
        WHERE listing_id=(SELECT listing_id FROM listing_revisions WHERE id=?)
        ORDER BY checked_at DESC,id DESC LIMIT 10`,
      params: [revisionId]
    }
  ]
}

/** Admin listing states: live, unlisted (unpublished), rejected, or blocked (prohibited). */
export const adminListingStatuses = ['live', 'unlisted', 'rejected', 'blocked', 'draft'] as const
export type AdminListingStatus = (typeof adminListingStatuses)[number]

/** The admin state of listing `l` (a prohibited rejection counts as blocked while its block holds). */
const adminStatusSql = `CASE
    WHEN EXISTS (SELECT 1 FROM listing_submissions s
      JOIN listing_submission_url_blocks b ON b.url_key=COALESCE(s.block_key,s.slug)
        AND b.lifted_at IS NULL
      WHERE s.listing_id=l.id AND s.status='rejected' AND s.rejection_category='prohibited')
      THEN 'blocked'
    WHEN EXISTS (SELECT 1 FROM listing_submissions s
      WHERE s.listing_id=l.id AND s.status='rejected') THEN 'rejected'
    WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL THEN 'live'
    WHEN l.status='approved' AND l.is_active=0 THEN 'unlisted'
    ELSE 'draft'
  END`

/** The columns of one listing row in the search and on its page (`l` is the listing). */
const adminListingColumns = `l.id,l.slug,l.name,l.website,l.source,l.link_rel,l.updated_at,
    l.created_at,l.published_at,l.source_kind,
    (SELECT url FROM listing_media m WHERE m.listing_id=l.id AND m.kind='logo'
      ORDER BY m.sort_order LIMIT 1) AS logo_url,
    ${listingHostedLogoKey('l.id')} AS logo_key,
    (SELECT u.email FROM listing_owners o JOIN users u ON u.id=o.user_id
      WHERE o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL) AS owner_email,
    (SELECT o.verified_via FROM listing_owners o
      WHERE o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL) AS owner_verified_via,
    (SELECT s.plan FROM listing_submissions s WHERE s.listing_id=l.id
      ORDER BY s.created_at DESC LIMIT 1) AS submission_plan,
    ${listingPaidSql('l.id')} AS plan,
    ${adminStatusSql} AS admin_status`

/** Search text (name or slug, any case) and facet filters, all bound; lists as JSON arrays. */
export interface AdminListingFilter {
  linkRels: readonly string[]
  query: string
  sources: readonly string[]
  statuses: readonly string[]
}

/** Listings matching the text, source, and link filters (?1, ?3, ?4), with their state. */
const filteredListings = `SELECT l.id,l.name,l.slug,l.source,l.link_rel,${adminStatusSql} AS admin_status
  FROM listings l
  WHERE (?1 = '' OR instr(lower(l.name), ?1) > 0 OR instr(l.slug, ?1) > 0)
    AND (?3 = '[]' OR l.source IN (SELECT value FROM json_each(?3)))
    AND (?4 = '[]' OR l.link_rel IN (SELECT value FROM json_each(?4)))`

const statusFilter = `(?2 = '[]' OR admin_status IN (SELECT value FROM json_each(?2)))`

function filterParams(filter: AdminListingFilter): unknown[] {
  return [
    filter.query.trim().toLowerCase(),
    JSON.stringify(filter.statuses),
    JSON.stringify(filter.sources),
    JSON.stringify(filter.linkRels)
  ]
}

/**
 * One page of the listing search in name order, the number of matches, and facet counts within
 * the search text. The page is chosen first, so the per-row columns are computed for its rows
 * only.
 */
export function selectAdminListingsPlans(
  filter: AdminListingFilter,
  page: { limit: number; offset: number }
): StatementPlan[] {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
    throw new Error('A listing page holds 1 to 100 rows.')
  }
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new Error('A listing page offset is a non-negative integer.')
  }
  const params = filterParams(filter)
  return [
    {
      sql: `WITH page AS (SELECT id,name,slug FROM (${filteredListings}) WHERE ${statusFilter}
          ORDER BY name COLLATE NOCASE,slug LIMIT ?5 OFFSET ?6)
        SELECT ${adminListingColumns} FROM page JOIN listings l ON l.id=page.id
        ORDER BY page.name COLLATE NOCASE,page.slug`,
      params: [...params, page.limit, page.offset]
    },
    {
      sql: `SELECT (SELECT COUNT(*) FROM (${filteredListings}) WHERE ${statusFilter}) AS matches,
          (SELECT COUNT(*) FROM listings) AS total`,
      params
    },
    {
      sql: `WITH base AS (${filteredListings.replace(/\?3/gu, "'[]'").replace(/\?4/gu, "'[]'")})
        SELECT 'status' AS facet,admin_status AS value,COUNT(*) AS count FROM base
          GROUP BY admin_status
        UNION ALL SELECT 'source',source,COUNT(*) FROM base GROUP BY source
        UNION ALL SELECT 'link',link_rel,COUNT(*) FROM base GROUP BY link_rel`,
      params: [params[0]]
    }
  ]
}

/**
 * One listing for its admin page: fields, primary category, logo, owner, state, its latest
 * submission and any active block on that submission's key, whether a submission is queued;
 * then its badge checks, its activity (listing events and its submissions' events), and its
 * ownership history.
 */
export function selectAdminListingPlans(slug: string): StatementPlan[] {
  const listingId = `(SELECT id FROM listings WHERE slug=?)`
  return [
    {
      sql: `SELECT ${adminListingColumns},l.description,l.checksum,l.is_active,l.status,
          (SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
            WHERE lc.listing_id=l.id AND lc.is_primary=1) AS category_slug,
          (SELECT c.name FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
            WHERE lc.listing_id=l.id AND lc.is_primary=1) AS category_name,
          (SELECT o.user_id FROM listing_owners o
            WHERE o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL) AS owner_user_id,
          (SELECT o.verified_at FROM listing_owners o
            WHERE o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL)
            AS owner_verified_at,
          CASE WHEN EXISTS (SELECT 1 FROM listing_submissions q WHERE q.listing_id=l.id
            AND q.status IN ('paid_pending_review','changes_requested')) THEN 1 ELSE 0 END
            AS submission_queued,
          (SELECT json_object('attempts',j.attempts,'lastError',j.last_error,
              'nextAttemptAt',j.next_attempt_at,'sourceUrl',j.source_url,'status',j.status)
            FROM media_ingestions j WHERE j.listing_id=l.id AND j.kind='logo' AND j.sort_order=0)
            AS logo_queue,
          s.id AS submission_id,s.status AS submission_status,s.paid_at AS submission_paid_at,
          s.refunded_at AS submission_refunded_at,s.rejection_reason,s.rejection_category,
          s.reviewed_by AS submission_reviewed_by,s.reviewed_at AS submission_reviewed_at,
          su.email AS submitter_email,su.created_at AS submitter_created_at,
          ${activeBlockColumns('COALESCE(s.block_key,s.slug)')}
        FROM listings l
          LEFT JOIN listing_submissions s ON s.id=(SELECT id FROM listing_submissions
            WHERE listing_id=l.id ORDER BY created_at DESC,id DESC LIMIT 1)
          LEFT JOIN users su ON su.id=s.owner_user_id
        WHERE l.slug=?`,
      params: [slug]
    },
    {
      sql: `SELECT id,checked_at,outcome,reason,conclusive FROM badge_checks
        WHERE listing_id=${listingId} ORDER BY checked_at DESC,id DESC LIMIT 20`,
      params: [slug]
    },
    {
      sql: `SELECT 'listing' AS source,e.id,e.event_type,e.detail,e.actor,e.created_at
        FROM listing_events e WHERE e.listing_id=${listingId}
        UNION ALL
        SELECT 'submission',e.id,e.event_type,e.detail,e.actor,e.created_at
        FROM listing_submission_events e JOIN listing_submissions s ON s.id=e.submission_id
        WHERE s.listing_id=${listingId}
        ORDER BY created_at DESC,id DESC LIMIT 50`,
      params: [slug, slug]
    },
    {
      sql: `SELECT o.user_id,u.email,o.verified_via,o.verified_at,o.revoked_at,o.revoked_reason
        FROM listing_owners o JOIN users u ON u.id=o.user_id
        WHERE o.listing_id=${listingId} ORDER BY o.id DESC`,
      params: [slug]
    }
  ]
}

/** The active prohibited-URL block on exactly this block key, if any ("Allow resubmission"). */
export function selectActiveUrlBlockPlan(urlKey: string): StatementPlan {
  return {
    sql: `SELECT id,url_key,reason,blocked_by,blocked_at FROM listing_submission_url_blocks
      WHERE url_key=? AND lifted_at IS NULL`,
    params: [urlKey]
  }
}

/**
 * Which rule stops a listing from moving to `website` (`listingWebsiteConflicts`): 1 or 0 for
 * `listing` (another listing), `submission` (one in flight), and `blocked` (an active block).
 */
export function selectListingWebsiteConflictPlan(input: {
  listingId: string
  website: string
}): StatementPlan {
  const conflicts = listingWebsiteConflicts(input)
  return {
    sql: `SELECT ${conflicts.listing.sql} AS listing,${conflicts.submission.sql} AS submission,
      ${conflicts.block.sql} AS blocked`,
    params: [...conflicts.listing.params, ...conflicts.submission.params, ...conflicts.block.params]
  }
}

/**
 * The block key a record's "Allow resubmission" acts on: a submission's own key, or the key of
 * a listing's latest submission (null when it has none). No row when the record doesn't exist.
 */
export function selectResubmissionTargetPlan(
  target: { listingId: string } | { submissionId: string }
): StatementPlan {
  return 'submissionId' in target
    ? {
        sql: `SELECT id,COALESCE(block_key,slug) AS block_key FROM listing_submissions WHERE id=?`,
        params: [target.submissionId]
      }
    : {
        sql: `SELECT l.id,(SELECT COALESCE(s.block_key,s.slug) FROM listing_submissions s
            WHERE s.listing_id=l.id ORDER BY s.created_at DESC,s.id DESC LIMIT 1) AS block_key
          FROM listings l WHERE l.id=?`,
        params: [target.listingId]
      }
}

/** Active categories for the category select, in display order. */
export function selectActiveCategoriesPlan(): StatementPlan {
  return {
    sql: `SELECT slug,name FROM categories WHERE is_active=1 ORDER BY sort_order,name`,
    params: []
  }
}

// ---------------------------------------------------------------------------------------------
// DTOs and the read operations

/**
 * D1 rows hold two time formats: `CURRENT_TIMESTAMP` defaults (`YYYY-MM-DD HH:MM:SS`, UTC) and
 * ISO instants written by plans; Better Auth writes epoch milliseconds. All become ISO instants.
 */
export function toInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  const text = String(value)
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : /^\d{4}-\d{2}-\d{2}$/u.test(text)
      ? `${text}T00:00:00Z`
      : text
  const time = Date.parse(normalized)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

export interface ReviewQueueItem {
  badge: BadgeCheckOutcome | null
  id: string
  kind: 'revision' | 'submission'
  listingId: string | null
  /** The hosted copy of `logoUrl`, if any (render this, never `logoUrl`). */
  logoKey: string | null
  logoUrl: string
  name: string
  ownerEmail: string | null
  paidAt: string | null
  plan: SubmissionPlan | null
  queuedAt: string | null
  refundedAt: string | null
  slug: string
  status: RevisionStatus | SubmissionStatus
  website: string
}

export interface ReviewQueueCounts {
  changes: number
  oldestQueuedAt: string | null
  waiting: number
}

export interface ResourceLink {
  label: string
  url: string
}

export interface Faq {
  answer: string
  question: string
}

export interface ActivityEvent {
  actor: string
  createdAt: string | null
  detail: string | null
  eventType: string
  id: number
  source: 'listing' | 'revision' | 'submission'
}

export interface BadgeCheckRecord {
  checkedAt: string | null
  conclusive: boolean
  id: number
  outcome: BadgeCheckOutcome
  reason: string | null
}

export interface ActiveBlock {
  blockedAt: string | null
  blockedBy: string
  reason: string
  urlKey: string
}

export interface Submitter {
  createdAt: string | null
  email: string
  otherSubmissions: number
  userId: string
}

export interface SubmissionReview {
  badgeChecks: BadgeCheckRecord[]
  badgeVerifiedAt: string | null
  block: ActiveBlock | null
  blockKey: string
  categoryName: string | null
  categorySlug: string
  content: string
  contentVersion: number
  createdAt: string | null
  description: string
  duplicateListings: number
  duplicateSubmissions: number
  events: ActivityEvent[]
  faqs: Faq[]
  id: string
  kind: 'submission'
  lastVerificationAt: string | null
  lastVerificationError: string | null
  listing: {
    checksum: string
    id: string
    linkRel: ListingLinkRel
    live: boolean
    publishedAt: string | null
    slug: string
  } | null
  /** The hosted copy of the submission's social image, if any (#95). */
  imageKey: string | null
  /** The featured image slot (hosted, waiting, or failed), for the reviewer (#96 round 2 B1). */
  imageSlot: AdminListingDetail['logoQueue']
  /** The hosted copy of `logoUrl`, if any: render this, never `logoUrl` (#96 S9). */
  logoKey: string | null
  logoUrl: string
  name: string
  paidAt: string | null
  plan: SubmissionPlan | null
  publishedChecksum: string | null
  refundedAt: string | null
  rejectionCategory: RejectionCategory | null
  rejectionReason: string | null
  resourceLinks: ResourceLink[]
  reviewedAt: string | null
  reviewedBy: string | null
  reviewerNote: string | null
  slug: string
  status: SubmissionStatus
  submitter: Submitter | null
  updatedAt: string | null
  verificationAttempts: number
  videoUrl: string | null
  website: string
  withdrawalReason: string | null
}

export interface RevisionReview {
  badgeChecks: BadgeCheckRecord[]
  baseChecksum: string
  categoryName: string | null
  categorySlug: string
  content: string
  contentVersion: number
  createdAt: string | null
  description: string
  events: ActivityEvent[]
  faqs: Faq[]
  id: string
  kind: 'revision'
  listing: {
    checksum: string
    id: string
    linkRel: ListingLinkRel
    live: boolean
    name: string
    slug: string
  }
  /** The hosted copy of `logoUrl`, if any: render this, never `logoUrl` (#96 S9). */
  logoKey: string | null
  logoUrl: string
  name: string
  plan: SubmissionPlan
  rejectionReason: string | null
  resourceLinks: ResourceLink[]
  reviewedAt: string | null
  reviewedBy: string | null
  reviewerNote: string | null
  slug: string
  /** False when the listing changed after the owner started the revision. */
  stale: boolean
  status: RevisionStatus
  submitter: Submitter | null
  updatedAt: string | null
  videoUrl: string | null
  website: string
}

export interface AdminListingRow {
  adminStatus: AdminListingStatus
  createdAt: string | null
  id: string
  linkRel: ListingLinkRel
  /** The hosted logo's key, if any: render this, never `logoUrl` (#96 S9). */
  logoKey: string | null
  logoUrl: string | null
  name: string
  ownerEmail: string | null
  ownerVerifiedVia: ListingOwnerVerification | null
  plan: SubmissionPlan
  publishedAt: string | null
  slug: string
  source: ListingSource
  sourceKind: string
  submissionPlan: SubmissionPlan | null
  updatedAt: string | null
  website: string
}

export interface AdminListingSearch {
  facets: Record<'link' | 'source' | 'status', Record<string, number>>
  matches: number
  rows: AdminListingRow[]
  total: number
}

export interface AdminListingDetail extends AdminListingRow {
  activity: ActivityEvent[]
  badgeChecks: BadgeCheckRecord[]
  block: ActiveBlock | null
  categoryName: string | null
  categorySlug: string | null
  checksum: string
  description: string
  /**
   * The logo when it is not hosted yet (#95): queued for the media cron (`pending`) or given up
   * (`failed`, with the reason). The page shows the fallback tile meanwhile.
   */
  /** The logo row's source the page shows now; `logoUrl` is the form's (queued or current). */
  currentLogoUrl: string | null
  logoQueue: {
    attempts: number
    lastError: string | null
    nextAttemptAt: string | null
    sourceUrl: string
    status: 'failed' | 'pending'
  } | null
  owner: {
    email: string
    userId: string
    verifiedAt: string | null
    verifiedVia: ListingOwnerVerification
  } | null
  ownerHistory: Array<{
    email: string
    revokedAt: string | null
    revokedReason: string | null
    userId: string
    verifiedAt: string | null
    verifiedVia: ListingOwnerVerification
  }>
  submission: {
    id: string
    paidAt: string | null
    refundedAt: string | null
    rejectionCategory: RejectionCategory | null
    rejectionReason: string | null
    reviewedAt: string | null
    reviewedBy: string | null
    status: SubmissionStatus
    submitterCreatedAt: string | null
    submitterEmail: string | null
  } | null
  submissionQueued: boolean
}

export interface CategoryOption {
  name: string
  slug: string
}

type Row = Record<string, unknown>

function parseLogoQueue(value: unknown): AdminListingDetail['logoQueue'] {
  if (typeof value !== 'string' || !value) return null
  const queue = JSON.parse(value) as Record<string, unknown>
  if (queue.status !== 'pending' && queue.status !== 'failed') return null
  return {
    attempts: Number(queue.attempts),
    lastError: optionalText(queue.lastError),
    nextAttemptAt: optionalText(queue.nextAttemptAt),
    sourceUrl: text(queue.sourceUrl),
    status: queue.status
  }
}

function events(rows: Row[], fallback: ActivityEvent['source']): ActivityEvent[] {
  return rows.map(row => ({
    actor: text(row.actor),
    createdAt: toInstant(row.created_at),
    detail: optionalText(row.detail),
    eventType: text(row.event_type),
    id: Number(row.id),
    source: (optionalText(row.source) as ActivityEvent['source'] | null) ?? fallback
  }))
}

function badgeChecks(rows: Row[]): BadgeCheckRecord[] {
  return rows.map(row => ({
    checkedAt: toInstant(row.checked_at),
    conclusive: Number(row.conclusive) === 1,
    id: Number(row.id),
    outcome: text(row.outcome) as BadgeCheckOutcome,
    reason: optionalText(row.reason)
  }))
}

function block(row: Row): ActiveBlock | null {
  const urlKey = optionalText(row.block_url_key)
  if (!urlKey) return null
  return {
    blockedAt: toInstant(row.block_blocked_at),
    blockedBy: text(row.block_blocked_by),
    reason: text(row.block_reason),
    urlKey
  }
}

function submitter(row: Row): Submitter | null {
  const email = optionalText(row.owner_email)
  if (!email) return null
  return {
    createdAt: toInstant(row.owner_created_at),
    email,
    otherSubmissions: Number(row.owner_other_submissions ?? 0),
    userId: text(row.owner_user_id)
  }
}

function listingRow(row: Row): AdminListingRow {
  return {
    adminStatus: text(row.admin_status) as AdminListingStatus,
    createdAt: toInstant(row.created_at),
    id: text(row.id),
    linkRel: text(row.link_rel) as ListingLinkRel,
    logoKey: optionalText(row.logo_key),
    logoUrl: optionalText(row.logo_url),
    name: text(row.name),
    ownerEmail: optionalText(row.owner_email),
    ownerVerifiedVia: optionalText(row.owner_verified_via) as ListingOwnerVerification | null,
    plan: text(row.plan) as SubmissionPlan,
    publishedAt: toInstant(row.published_at),
    slug: text(row.slug),
    source: text(row.source) as ListingSource,
    sourceKind: text(row.source_kind),
    submissionPlan: optionalText(row.submission_plan) as SubmissionPlan | null,
    updatedAt: toInstant(row.updated_at),
    website: text(row.website)
  }
}

export interface AdminAllowlistEntry {
  addedAt: string | null
  addedBy: string
  email: string
  name: string | null
}

export interface AdminReadOperations {
  listAdmins(): Promise<AdminAllowlistEntry[]>
  getAdminListing(slug: string): Promise<AdminListingDetail | null>
  getRevisionReview(revisionId: string): Promise<RevisionReview | null>
  getSubmissionReview(submissionId: string): Promise<SubmissionReview | null>
  listActiveCategories(): Promise<CategoryOption[]>
  listReviewQueue(view: ReviewQueueView): Promise<ReviewQueueItem[]>
  reviewQueueCounts(): Promise<ReviewQueueCounts>
  searchListings(
    filter: AdminListingFilter,
    page: { limit: number; offset: number }
  ): Promise<AdminListingSearch>
}

export function createAdminReadOperations({ client }: { client: Database }): AdminReadOperations {
  const db = client.binding
  const statement = (plan: StatementPlan) => db.prepare(plan.sql).bind(...plan.params)
  async function batch(plans: StatementPlan[]): Promise<Row[][]> {
    const results = await db.batch<Row>(plans.map(statement))
    return results.map(result => result.results ?? [])
  }

  return {
    async getAdminListing(slug) {
      const [rows, checks, activity, owners] = await batch(selectAdminListingPlans(slug))
      const row = rows?.[0]
      if (!row) return null
      const ownerEmail = optionalText(row.owner_email)
      const submissionId = optionalText(row.submission_id)
      const logoQueue = parseLogoQueue(row.logo_queue)
      const listing = listingRow(row)
      return {
        ...listing,
        // The logo row the page shows now (hosted, imported, or none).
        currentLogoUrl: listing.logoUrl,
        // A queued logo is the logo the admin set last: the form shows its source (#96 r2 S2).
        logoUrl: logoQueue?.sourceUrl ?? listing.logoUrl ?? null,
        logoQueue,
        activity: events(activity ?? [], 'listing'),
        badgeChecks: badgeChecks(checks ?? []),
        block: block(row),
        categoryName: optionalText(row.category_name),
        categorySlug: optionalText(row.category_slug),
        checksum: text(row.checksum),
        description: text(row.description),
        owner: ownerEmail
          ? {
              email: ownerEmail,
              userId: text(row.owner_user_id),
              verifiedAt: toInstant(row.owner_verified_at),
              verifiedVia: text(row.owner_verified_via) as ListingOwnerVerification
            }
          : null,
        ownerHistory: (owners ?? []).map(owner => ({
          email: text(owner.email),
          revokedAt: toInstant(owner.revoked_at),
          revokedReason: optionalText(owner.revoked_reason),
          userId: text(owner.user_id),
          verifiedAt: toInstant(owner.verified_at),
          verifiedVia: text(owner.verified_via) as ListingOwnerVerification
        })),
        submission: submissionId
          ? {
              id: submissionId,
              paidAt: toInstant(row.submission_paid_at),
              refundedAt: toInstant(row.submission_refunded_at),
              rejectionCategory: optionalText(row.rejection_category) as RejectionCategory | null,
              rejectionReason: optionalText(row.rejection_reason),
              reviewedAt: toInstant(row.submission_reviewed_at),
              reviewedBy: optionalText(row.submission_reviewed_by),
              status: text(row.submission_status) as SubmissionStatus,
              submitterCreatedAt: toInstant(row.submitter_created_at),
              submitterEmail: optionalText(row.submitter_email)
            }
          : null,
        submissionQueued: Number(row.submission_queued) === 1
      }
    },

    async getRevisionReview(revisionId) {
      const [rows, links, faqs, revisionEvents, checks] = await batch(
        selectRevisionReviewPlans(revisionId)
      )
      const row = rows?.[0]
      if (!row) return null
      return {
        badgeChecks: badgeChecks(checks ?? []),
        baseChecksum: text(row.base_checksum),
        categoryName: optionalText(row.category_name),
        categorySlug: text(row.category_slug),
        content: text(row.content),
        contentVersion: Number(row.content_version),
        createdAt: toInstant(row.created_at),
        description: text(row.description),
        events: events(revisionEvents ?? [], 'revision'),
        faqs: (faqs ?? []).map(faq => ({ answer: text(faq.answer), question: text(faq.question) })),
        id: text(row.id),
        kind: 'revision',
        listing: {
          checksum: text(row.listing_checksum),
          id: text(row.listing_id),
          linkRel: text(row.listing_link_rel) as ListingLinkRel,
          live: Number(row.listing_live) === 1,
          name: text(row.listing_name),
          slug: text(row.slug)
        },
        logoKey: optionalText(row.logo_key),
        logoUrl: text(row.logo_url),
        name: text(row.name),
        plan: text(row.plan) as SubmissionPlan,
        rejectionReason: optionalText(row.rejection_reason),
        resourceLinks: (links ?? []).map(link => ({
          label: text(link.label),
          url: text(link.url)
        })),
        reviewedAt: toInstant(row.reviewed_at),
        reviewedBy: optionalText(row.reviewed_by),
        reviewerNote: optionalText(row.reviewer_note),
        slug: text(row.slug),
        stale: text(row.base_checksum) !== text(row.listing_checksum),
        status: text(row.status) as RevisionStatus,
        submitter: submitter(row),
        updatedAt: toInstant(row.updated_at),
        videoUrl: optionalText(row.video_url),
        website: text(row.website)
      }
    },

    async getSubmissionReview(submissionId) {
      const [rows, links, faqs, submissionEvents, checks] = await batch(
        selectSubmissionReviewPlans(submissionId)
      )
      const row = rows?.[0]
      if (!row) return null
      const listingId = optionalText(row.listing_id)
      return {
        badgeChecks: badgeChecks(checks ?? []),
        badgeVerifiedAt: toInstant(row.badge_verified_at),
        block: block(row),
        blockKey: text(row.block_key),
        categoryName: optionalText(row.category_name),
        categorySlug: text(row.category_slug),
        content: text(row.content),
        contentVersion: Number(row.content_version),
        createdAt: toInstant(row.created_at),
        description: text(row.description),
        duplicateListings: Number(row.duplicate_listings ?? 0),
        duplicateSubmissions: Number(row.duplicate_submissions ?? 0),
        events: events(submissionEvents ?? [], 'submission'),
        faqs: (faqs ?? []).map(faq => ({ answer: text(faq.answer), question: text(faq.question) })),
        id: text(row.id),
        kind: 'submission',
        lastVerificationAt: toInstant(row.last_verification_at),
        lastVerificationError: optionalText(row.last_verification_error),
        listing:
          listingId && optionalText(row.listing_slug)
            ? {
                checksum: text(row.listing_checksum),
                id: listingId,
                linkRel: text(row.listing_link_rel) as ListingLinkRel,
                live: Number(row.listing_live) === 1,
                publishedAt: toInstant(row.listing_published_at),
                slug: text(row.listing_slug)
              }
            : null,
        imageKey: optionalText(row.image_key),
        imageSlot: parseLogoQueue(row.image_slot),
        logoKey: optionalText(row.logo_key),
        logoUrl: text(row.logo_url),
        name: text(row.name),
        paidAt: toInstant(row.paid_at),
        plan: optionalText(row.plan) as SubmissionPlan | null,
        publishedChecksum: optionalText(row.published_checksum),
        refundedAt: toInstant(row.refunded_at),
        rejectionCategory: optionalText(row.rejection_category) as RejectionCategory | null,
        rejectionReason: optionalText(row.rejection_reason),
        resourceLinks: (links ?? []).map(link => ({
          label: text(link.label),
          url: text(link.url)
        })),
        reviewedAt: toInstant(row.reviewed_at),
        reviewedBy: optionalText(row.reviewed_by),
        reviewerNote: optionalText(row.reviewer_note),
        slug: text(row.slug),
        status: text(row.status) as SubmissionStatus,
        submitter: submitter(row),
        updatedAt: toInstant(row.updated_at),
        verificationAttempts: Number(row.verification_attempts ?? 0),
        videoUrl: optionalText(row.video_url),
        website: text(row.website),
        withdrawalReason: optionalText(row.withdrawal_reason)
      }
    },

    async listAdmins() {
      const result = await statement(selectAdminAllowlistPlan()).all<Row>()
      return result.results.map(row => ({
        addedAt: toInstant(row.created_at),
        addedBy: text(row.added_by),
        email: text(row.email),
        name: optionalText(row.name)
      }))
    },

    async listActiveCategories() {
      const result = await statement(selectActiveCategoriesPlan()).all<Row>()
      return result.results.map(row => ({ name: text(row.name), slug: text(row.slug) }))
    },

    async listReviewQueue(view) {
      const result = await statement(selectReviewQueuePlan(view)).all<Row>()
      return result.results.map(row => ({
        badge: optionalText(row.badge) as BadgeCheckOutcome | null,
        id: text(row.id),
        kind: text(row.kind) as ReviewQueueItem['kind'],
        listingId: optionalText(row.listing_id),
        logoKey: optionalText(row.logo_key),
        logoUrl: text(row.logo_url),
        name: text(row.name),
        ownerEmail: optionalText(row.owner_email),
        paidAt: toInstant(row.paid_at),
        plan: optionalText(row.plan) as SubmissionPlan | null,
        queuedAt: toInstant(row.queued_at),
        refundedAt: toInstant(row.refunded_at),
        slug: text(row.slug),
        status: text(row.status) as ReviewQueueItem['status'],
        website: text(row.website)
      }))
    },

    async reviewQueueCounts() {
      const row = await statement(selectReviewQueueCountsPlan()).first<Row>()
      return {
        changes: Number(row?.changes ?? 0),
        oldestQueuedAt: toInstant(row?.oldest_queued_at),
        waiting: Number(row?.waiting ?? 0)
      }
    },

    async searchListings(filter, page) {
      const [rows, totals, facets] = await batch(selectAdminListingsPlans(filter, page))
      const facetCounts: AdminListingSearch['facets'] = { link: {}, source: {}, status: {} }
      for (const facet of facets ?? []) {
        const name = text(facet.facet) as keyof AdminListingSearch['facets']
        facetCounts[name][text(facet.value)] = Number(facet.count)
      }
      return {
        facets: facetCounts,
        matches: Number(totals?.[0]?.matches ?? 0),
        rows: (rows ?? []).map(listingRow),
        total: Number(totals?.[0]?.total ?? 0)
      }
    }
  }
}
