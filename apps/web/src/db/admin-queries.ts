import { selectAdminAllowlistPlan } from './admin-plans'
import type { Database } from './client'
import { toInstant } from './instants'
import { listingWebsiteConflicts } from './listing-plans'
import {
  claimPaymentLossSql,
  type PaymentLoss,
  submissionPaymentLossSql,
  toPaymentLoss
} from './payment-kept'
import { type CategorySuggestion, parseTagSlugs, type StatementPlan } from './plan-support'
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
import { taxonomyRendersSql } from './taxonomy-plans'

/**
 * Reads for the admin panel (serpcompany/best.serp.co#64): the review queue, one submission or
 * revision under review, the listing search, one listing with its owner, badge checks, and
 * activity, the category and tag options, and the taxonomy screens' categories, tags, and best
 * pages (#405). Every statement is a plan builder (`select…Plan`), so
 * `scripts/d1-workerd-plans.test.ts` runs each one on Wrangler-local D1, and
 * `createAdminReadOperations` maps the rows to the DTOs the admin pages render. Nothing here
 * writes; the decisions are the statement plans in `submission-plans.ts`, `revision-plans.ts`,
 * `listing-plans.ts`, `admin-plans.ts`, and `taxonomy-plans.ts`.
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

/**
 * Whether a listing is on the paid plan: a paid claim, or a paid submission, whose payment is
 * still kept (`payment-kept.ts`: not refunded, nor disputed and not won, #473). A claim's is its
 * owner's latest claim payment; a paid claim's owner stays the owner until an admin decides.
 */
const listingPaidSql = (listingIdSql: string) => `CASE WHEN EXISTS (SELECT 1 FROM listing_owners po
    WHERE po.listing_id=${listingIdSql} AND po.revoked_at IS NULL AND po.verified_via='paid_claim'
      AND ${claimPaymentLossSql('po.listing_id', 'po.user_id')} IS NULL)
  OR EXISTS (SELECT 1 FROM listing_submissions ps WHERE ps.listing_id=${listingIdSql}
    AND ps.plan='paid' AND ps.paid_at IS NOT NULL
    AND ps.status IN ('paid_pending_review','approved') AND ${submissionPaymentLossSql('ps')} IS NULL)
  THEN 'paid' ELSE 'free' END`

const latestConclusiveBadge = (listingIdSql: string) => `(SELECT outcome FROM badge_checks
  WHERE listing_id=${listingIdSql} AND conclusive=1 ORDER BY checked_at DESC,id DESC LIMIT 1)`

/**
 * Hosted copies the admin screens render instead of a source URL (#96 review S9): a
 * submission's or a revision's hosted slot for its current source, or the listing's hosted logo
 * when a revision keeps it. A source with no hosted copy is shown as a link, never as an image.
 * The revision form matches `stagedLogoKeySql`, which approval compares and swaps on.
 */
function submissionHostedKey(submission: string, kind: 'image' | 'logo', source?: string): string {
  return `(SELECT j.media_key FROM media_ingestions j WHERE j.submission_id=${submission}.id
    AND j.kind='${kind}' AND j.sort_order=0 AND j.status='hosted'${source ? ` AND j.source_url=${source}` : ''})`
}

function revisionHostedLogoKey(revision: string): string {
  return `COALESCE((SELECT j.media_key FROM media_ingestions j WHERE j.revision_id=${revision}.id
      AND j.kind='logo' AND j.sort_order=0 AND j.status='hosted'
      AND j.source_url=${revision}.logo_url),
    ${listingHostedLogoKey(`${revision}.listing_id`, `${revision}.logo_url`)})`
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
          s.paid_at,s.refunded_at,${submissionPaymentLossSql('s')} AS payment_loss,s.listing_id,
          u.email AS owner_email,CASE WHEN s.badge_verified_at IS NOT NULL THEN 'pass' END AS badge,
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
          ${revisionHostedLogoKey('r')},r.status,
          ${listingPaidSql('r.listing_id')},NULL,NULL,NULL,r.listing_id,u.email,
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
          ${submissionPaymentLossSql('s')} AS payment_loss,
          ${submissionHostedKey('s', 'logo', 's.logo_url')} AS logo_key,
          ${submissionHostedKey('s', 'image')} AS image_key,
          s.verification_attempts,s.last_verification_at,s.last_verification_error,
          s.badge_verified_at,s.reviewed_at,s.reviewed_by,s.reviewer_note,s.rejection_reason,
          s.rejection_category,s.withdrawal_reason,s.created_at,s.updated_at,s.content_version,
          s.listing_id,s.published_checksum,COALESCE(s.block_key,s.slug) AS block_key,s.tag_slugs,
          s.suggested_category,s.suggested_category_note,
          u.id AS owner_user_id,u.email AS owner_email,u.created_at AS owner_created_at,
          (SELECT COUNT(*) FROM listing_submissions o
            WHERE o.owner_user_id=s.owner_user_id AND o.id!=s.id) AS owner_other_submissions,
          l.slug AS listing_slug,l.link_rel AS listing_link_rel,l.checksum AS listing_checksum,
          CASE WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
            THEN 1 ELSE 0 END AS listing_live,
          l.published_at AS listing_published_at,
          EXISTS (SELECT 1 FROM listing_owners lo WHERE lo.listing_id=l.id AND lo.role='owner'
            AND lo.revoked_at IS NULL) AS listing_verified_owner,
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
          ${revisionHostedLogoKey('r')} AS logo_key,
          r.rejection_reason,r.reviewed_at,r.reviewed_by,r.created_at,r.updated_at,
          r.content_version,r.tag_slugs,r.suggested_category,r.suggested_category_note,l.slug,
          l.website,l.name AS listing_name,
          l.checksum AS listing_checksum,
          l.link_rel AS listing_link_rel,
          CASE WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
            THEN 1 ELSE 0 END AS listing_live,
          EXISTS (SELECT 1 FROM listing_owners lo WHERE lo.listing_id=l.id AND lo.role='owner'
            AND lo.revoked_at IS NULL) AS listing_verified_owner,
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
          (SELECT json_group_array(name) FROM (SELECT c.name FROM listing_categories lc
            JOIN categories c ON c.id=lc.category_id
            WHERE lc.listing_id=l.id AND c.is_active=0 ORDER BY lc.sort_order))
            AS retired_categories,
          (SELECT json_group_array(json_object('slug',slug,'name',name,'active',is_active))
            FROM (SELECT t.slug,t.name,t.is_active FROM listing_tags lt
              JOIN tags t ON t.id=lt.tag_id WHERE lt.listing_id=l.id
              ORDER BY lt.sort_order,t.slug)) AS tags,
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
          ${submissionPaymentLossSql('s')} AS submission_payment_loss,
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

/**
 * Active tags for the tag fields (#341), with their hubs, in the hubs' display order and then
 * the tags' own.
 */
export function selectActiveTagsPlan(): StatementPlan {
  return {
    sql: `SELECT t.slug,t.name,c.slug AS category,c.name AS category_name FROM tags t
      JOIN categories c ON c.id=t.category_id AND c.is_active=1
      WHERE t.is_active=1 ORDER BY c.sort_order,c.name,t.sort_order,t.name`,
    params: []
  }
}

/** A listing anonymous visitors can see, at any publication time. */
const LIVE_LISTING = "l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL"

/**
 * Active categories (hubs) for the Categories screen (#405), or the one with `slug`, with how
 * many active tags and live listings (filed under it as their primary) each has, and whether its
 * page renders at `asOf` (`taxonomyRendersSql`).
 */
export function selectAdminCategoriesPlan(asOf: string, slug?: string): StatementPlan {
  const renders = taxonomyRendersSql('category', 'c', asOf)
  return {
    sql: `SELECT c.slug,c.name,c.description,c.sort_order,
        (SELECT COUNT(*) FROM tags t WHERE t.category_id=c.id AND t.is_active=1) AS tag_count,
        (SELECT COUNT(*) FROM listing_categories lc JOIN listings l ON l.id=lc.listing_id
          WHERE lc.category_id=c.id AND lc.is_primary=1 AND ${LIVE_LISTING}) AS listing_count,
        CASE WHEN ${renders.sql} THEN 1 ELSE 0 END AS renders
      FROM categories c WHERE c.is_active=1${slug === undefined ? '' : ' AND c.slug=?'}
      ORDER BY c.sort_order,c.name`,
    params: [...renders.params, ...(slug === undefined ? [] : [slug])]
  }
}

/**
 * Active tags for the Tags screen (#405), or the one with `slug`, with their hubs, how many live
 * listings carry each, and whether its page renders at `asOf`, in the hubs' display order and then
 * the tags' own.
 */
export function selectAdminTagsPlan(asOf: string, slug?: string): StatementPlan {
  const renders = taxonomyRendersSql('tag', 't', asOf)
  return {
    sql: `SELECT t.slug,t.name,t.description,t.sort_order,c.slug AS category,
        c.name AS category_name,
        (SELECT COUNT(*) FROM listing_tags lt JOIN listings l ON l.id=lt.listing_id
          WHERE lt.tag_id=t.id AND ${LIVE_LISTING}) AS listing_count,
        CASE WHEN ${renders.sql} THEN 1 ELSE 0 END AS renders
      FROM tags t JOIN categories c ON c.id=t.category_id
      WHERE t.is_active=1${slug === undefined ? '' : ' AND t.slug=?'}
      ORDER BY c.sort_order,c.name,t.sort_order,t.name`,
    params: [...renders.params, ...(slug === undefined ? [] : [slug])]
  }
}

/**
 * Active best pages for the Best pages screen (#405), with their pool, how many pins, and whether
 * the page renders at `asOf`.
 */
export function selectAdminBestPagesPlan(asOf: string): StatementPlan {
  const renders = taxonomyRendersSql('best', 'b', asOf)
  return {
    sql: `SELECT b.slug,b.keyword,b.title,t.slug AS tag,t.name AS tag_name,c.slug AS category,
        c.name AS category_name,
        (SELECT COUNT(*) FROM best_page_listings p
          WHERE p.best_page_id=b.id AND p.excluded=0) AS pin_count,
        CASE WHEN ${renders.sql} THEN 1 ELSE 0 END AS renders
      FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id
      LEFT JOIN categories c ON c.id=b.category_id
      WHERE b.is_active=1 ORDER BY b.sort_order,b.keyword,b.slug`,
    params: renders.params
  }
}

/**
 * Which of `ids` are live listings of a best page's pool with this tag and category (#405): with
 * the tag (or, without one, filed under the category), and filed under the category when it names
 * one too. A best page's tag changes only while its pins all stay in its pool.
 */
export function selectListingsInPoolPlan(input: {
  category: string | null
  ids: readonly string[]
  tag: string | null
}): StatementPlan {
  return {
    sql: `SELECT l.id FROM listings l
      WHERE l.id IN (SELECT value FROM json_each(?1)) AND ${LIVE_LISTING}
        AND (?2 IS NULL OR EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id=lt.tag_id
          WHERE lt.listing_id=l.id AND t.slug=?2))
        AND (?3 IS NULL OR EXISTS (SELECT 1 FROM listing_categories lc
          JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=l.id AND c.slug=?3))
      ORDER BY l.id`,
    params: [JSON.stringify(input.ids), input.tag, input.category]
  }
}

/**
 * One active best page (#405): its fields, its pins in position order (each with whether it is
 * live), its exclusions, and its live pool, the listings its pins are chosen from: those with its
 * tag (or, on a page without one, in its category), in its category when it names one too, less
 * its exclusions, by name, each with whether it names a feature of a larger site (#409), which is
 * never pinned.
 */
export function selectAdminBestPagePlans(slug: string): StatementPlan[] {
  return [
    {
      sql: `SELECT b.slug,b.keyword,b.title,b.heading,b.intro,b.list_size,t.slug AS tag,
          t.name AS tag_name,c.slug AS category,c.name AS category_name
        FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id
        LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug=? AND b.is_active=1`,
      params: [slug]
    },
    {
      sql: `SELECT l.id,l.slug,l.name,p.blurb,
          CASE WHEN ${LIVE_LISTING} THEN 1 ELSE 0 END AS live
        FROM best_pages b JOIN best_page_listings p ON p.best_page_id=b.id
        JOIN listings l ON l.id=p.listing_id
        WHERE b.slug=? AND p.excluded=0 ORDER BY p.position`,
      params: [slug]
    },
    {
      sql: `SELECT l.id,l.slug,l.name FROM best_pages b
        JOIN best_page_listings p ON p.best_page_id=b.id JOIN listings l ON l.id=p.listing_id
        WHERE b.slug=? AND p.excluded=1 ORDER BY l.name,l.slug`,
      params: [slug]
    },
    {
      sql: `SELECT l.id,l.slug,l.name,l.is_feature_listing FROM best_pages b JOIN listings l
          ON l.id IN (SELECT lt.listing_id FROM listing_tags lt WHERE lt.tag_id=b.tag_id
            UNION ALL SELECT lc.listing_id FROM listing_categories lc
              WHERE b.tag_id IS NULL AND lc.category_id=b.category_id)
        WHERE b.slug=? AND b.is_active=1 AND ${LIVE_LISTING}
          AND (b.category_id IS NULL OR EXISTS (SELECT 1 FROM listing_categories lc
            WHERE lc.listing_id=l.id AND lc.category_id=b.category_id))
          AND NOT EXISTS (SELECT 1 FROM best_page_listings x
            WHERE x.best_page_id=b.id AND x.listing_id=l.id AND x.excluded=1)
        ORDER BY l.name,l.slug`,
      params: [slug]
    }
  ]
}

/** The most open category suggestions the admin page reads (#406), as the review queue's. */
export const SUGGESTIONS_LIMIT = QUEUE_LIMIT

/**
 * Open category suggestions (#406): each submission or revision still on its way to a decision
 * that suggests a category, with the record it came with, so repeats show side by side, at most
 * `limit` of them in name order. Drafts aren't submitted yet, and decided ones are closed.
 */
export function selectCategorySuggestionsPlan(limit = SUGGESTIONS_LIMIT): StatementPlan {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('A limit is a positive integer.')
  return {
    sql: `SELECT 'submission' AS kind,s.id AS id,s.name AS listing_name,s.status AS status,
        s.suggested_category AS name,s.suggested_category_note AS note,
        c.name AS category_name,s.created_at AS created_at
      FROM listing_submissions s LEFT JOIN categories c ON c.slug=s.category_slug
      WHERE s.suggested_category IS NOT NULL
        AND s.status IN ('pending_badge','verified','paid_pending_review','changes_requested')
      UNION ALL
      SELECT 'revision',r.id,l.name,r.status,r.suggested_category,r.suggested_category_note,
        c.name,r.created_at
      FROM listing_revisions r JOIN listings l ON l.id=r.listing_id
        LEFT JOIN categories c ON c.slug=r.category_slug
      WHERE r.suggested_category IS NOT NULL AND r.status IN ('pending_review','changes_requested')
      ORDER BY name COLLATE NOCASE,created_at,id LIMIT ?`,
    params: [limit]
  }
}

// ---------------------------------------------------------------------------------------------
// DTOs and the read operations

export { toInstant }

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
  /** A paid submission's payment no longer kept (`payment-kept.ts`), or null. */
  paymentLoss: PaymentLoss | null
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
    /** The live listing has a current owner now, so its page shows "Verified owner". */
    verifiedOwner: boolean
  } | null
  /** The hosted copy of the submission's social image, if any (#95). */
  imageKey: string | null
  /** The hosted copy of `logoUrl`, if any: render this, never `logoUrl` (#96 S9). */
  logoKey: string | null
  logoUrl: string
  name: string
  paidAt: string | null
  /** Its payment no longer kept (`payment-kept.ts`): refunded, or disputed and not won. */
  paymentLoss: PaymentLoss | null
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
  /** A category the Creator suggests (#406), or null. */
  suggestion: CategorySuggestion | null
  /** The Creator's suggested tags (#341), or null when none were given. */
  tagSlugs: string[] | null
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
    /**
     * The listing has a current owner now, so its page shows "Verified owner". A revision proves
     * ownership only when it was started: the owner may since be revoked or replaced.
     */
    verifiedOwner: boolean
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
  /** A category the owner suggests (#406), or null. */
  suggestion: CategorySuggestion | null
  /** The owner's tags (#341), or null: approval then leaves the listing's tags as they are. */
  tagSlugs: string[] | null
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
  /** Names of the retired categories it is filed under (#260): it can't be republished. */
  retiredCategories: string[]
  submission: {
    id: string
    paidAt: string | null
    /** Its payment no longer kept (`payment-kept.ts`): refunded, or disputed and not won. */
    paymentLoss: PaymentLoss | null
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
  /** Its tags in order (the first is the most central), retired ones included (#341). */
  tags: ListingTag[]
}

export interface ListingTag {
  active: boolean
  name: string
  slug: string
}

export interface CategoryOption {
  name: string
  slug: string
}

/** An active tag with its hub (#341). */
export interface TagOption {
  category: string
  categoryName: string
  name: string
  slug: string
}

/** An active category (hub) on the Categories screen (#405). */
export interface AdminCategory {
  description: string
  /** Live listings filed under it as their primary category. */
  listingCount: number
  name: string
  order: number
  /** Its page renders now: a public listing is filed under it. */
  renders: boolean
  slug: string
  tagCount: number
}

/** An active tag on the Tags screen (#405). */
export interface AdminTag {
  category: string
  categoryName: string
  description: string
  listingCount: number
  name: string
  order: number
  /** Its page renders now: a public listing carries it. */
  renders: boolean
  slug: string
}

/** An active best page on the Best pages screen (#405). */
export interface AdminBestPageRow {
  category: string | null
  categoryName: string | null
  keyword: string
  pinCount: number
  /** Its page renders now: it has an entry. */
  renders: boolean
  slug: string
  tag: string | null
  tagName: string | null
  title: string
}

/** A listing a best page pins, excludes, or may pin. */
export interface BestPageListing {
  id: string
  name: string
  slug: string
}

/** One active best page with its pins, exclusions, and live pool (#405). */
export interface AdminBestPage extends AdminBestPageRow {
  exclude: BestPageListing[]
  heading: string
  intro: string
  listSize: number
  pins: Array<BestPageListing & { blurb: string | null; live: boolean }>
  /** `featureListing`: it names a feature of a larger site (#409), so it is never pinned. */
  pool: Array<BestPageListing & { featureListing: boolean }>
}

/** One open category suggestion (#406) and the submission or revision it came with. */
export interface CategorySuggestionRow {
  /** The primary category the record names meanwhile. */
  categoryName: string | null
  createdAt: string | null
  id: string
  kind: 'revision' | 'submission'
  listingName: string
  name: string
  note: string | null
  status: string
}

type Row = Record<string, unknown>

function suggestionOf(row: Row): CategorySuggestion | null {
  const name = optionalText(row.suggested_category)
  return name ? { name, note: optionalText(row.suggested_category_note) } : null
}

function parseListingTags(value: unknown): ListingTag[] {
  if (typeof value !== 'string' || !value) return []
  return (JSON.parse(value) as Array<Record<string, unknown>>).map(tag => ({
    active: Number(tag.active) === 1,
    name: text(tag.name),
    slug: text(tag.slug)
  }))
}

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
  getAdminBestPage(slug: string): Promise<AdminBestPage | null>
  /** The taxonomy reads take the instant their `renders` is judged at. */
  getAdminCategory(slug: string, asOf: string): Promise<AdminCategory | null>
  getAdminTag(slug: string, asOf: string): Promise<AdminTag | null>
  listActiveCategories(): Promise<CategoryOption[]>
  listActiveTags(): Promise<TagOption[]>
  listAdminBestPages(asOf: string): Promise<AdminBestPageRow[]>
  listAdminCategories(asOf: string): Promise<AdminCategory[]>
  listAdminTags(asOf: string): Promise<AdminTag[]>
  /** Up to `limit` (500) open suggestions, and whether there are more. */
  listCategorySuggestions(
    limit?: number
  ): Promise<{ rows: CategorySuggestionRow[]; truncated: boolean }>
  listReviewQueue(view: ReviewQueueView): Promise<ReviewQueueItem[]>
  reviewQueueCounts(): Promise<ReviewQueueCounts>
  searchListings(
    filter: AdminListingFilter,
    page: { limit: number; offset: number }
  ): Promise<AdminListingSearch>
}

function categoryRow(row: Row): AdminCategory {
  return {
    description: text(row.description),
    listingCount: Number(row.listing_count),
    name: text(row.name),
    order: Number(row.sort_order),
    renders: Number(row.renders) === 1,
    slug: text(row.slug),
    tagCount: Number(row.tag_count)
  }
}

function tagRow(row: Row): AdminTag {
  return {
    category: text(row.category),
    categoryName: text(row.category_name),
    description: text(row.description),
    listingCount: Number(row.listing_count),
    name: text(row.name),
    order: Number(row.sort_order),
    renders: Number(row.renders) === 1,
    slug: text(row.slug)
  }
}

function bestPageRow(row: Row): AdminBestPageRow {
  return {
    category: optionalText(row.category),
    categoryName: optionalText(row.category_name),
    keyword: text(row.keyword),
    pinCount: Number(row.pin_count),
    renders: Number(row.renders) === 1,
    slug: text(row.slug),
    tag: optionalText(row.tag),
    tagName: optionalText(row.tag_name),
    title: text(row.title)
  }
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
        retiredCategories: (
          JSON.parse(optionalText(row.retired_categories) ?? '[]') as unknown[]
        ).map(name => text(name)),
        submission: submissionId
          ? {
              id: submissionId,
              paidAt: toInstant(row.submission_paid_at),
              paymentLoss: toPaymentLoss(row.submission_payment_loss),
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
        submissionQueued: Number(row.submission_queued) === 1,
        tags: parseListingTags(row.tags)
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
          slug: text(row.slug),
          verifiedOwner: Number(row.listing_verified_owner) === 1
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
        suggestion: suggestionOf(row),
        tagSlugs: parseTagSlugs(row.tag_slugs),
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
                slug: text(row.listing_slug),
                verifiedOwner: Number(row.listing_verified_owner) === 1
              }
            : null,
        imageKey: optionalText(row.image_key),
        logoKey: optionalText(row.logo_key),
        logoUrl: text(row.logo_url),
        name: text(row.name),
        paidAt: toInstant(row.paid_at),
        paymentLoss: toPaymentLoss(row.payment_loss),
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
        suggestion: suggestionOf(row),
        tagSlugs: parseTagSlugs(row.tag_slugs),
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

    async getAdminBestPage(slug) {
      const [rows, pins, exclude, pool] = await batch(selectAdminBestPagePlans(slug))
      const row = rows?.[0]
      if (!row) return null
      const listingRef = (entry: Row): BestPageListing => ({
        id: text(entry.id),
        name: text(entry.name),
        slug: text(entry.slug)
      })
      return {
        // It renders with a live pin or a live listing of its pool.
        ...bestPageRow({
          ...row,
          pin_count: pins?.length ?? 0,
          renders:
            (pins ?? []).some(pin => Number(pin.live) === 1) || (pool?.length ?? 0) > 0 ? 1 : 0
        }),
        exclude: (exclude ?? []).map(listingRef),
        heading: text(row.heading),
        intro: text(row.intro),
        listSize: Number(row.list_size),
        pins: (pins ?? []).map(pin => ({
          ...listingRef(pin),
          blurb: optionalText(pin.blurb),
          live: Number(pin.live) === 1
        })),
        pool: (pool ?? []).map(entry => ({
          ...listingRef(entry),
          featureListing: Number(entry.is_feature_listing) === 1
        }))
      }
    },

    async getAdminCategory(slug, asOf) {
      const row = await statement(selectAdminCategoriesPlan(asOf, slug)).first<Row>()
      return row ? categoryRow(row) : null
    },

    async getAdminTag(slug, asOf) {
      const row = await statement(selectAdminTagsPlan(asOf, slug)).first<Row>()
      return row ? tagRow(row) : null
    },

    async listAdminBestPages(asOf) {
      const result = await statement(selectAdminBestPagesPlan(asOf)).all<Row>()
      return result.results.map(bestPageRow)
    },

    async listAdminCategories(asOf) {
      const result = await statement(selectAdminCategoriesPlan(asOf)).all<Row>()
      return result.results.map(categoryRow)
    },

    async listAdminTags(asOf) {
      const result = await statement(selectAdminTagsPlan(asOf)).all<Row>()
      return result.results.map(tagRow)
    },

    async listCategorySuggestions(limit = SUGGESTIONS_LIMIT) {
      // One more than shown says whether there are more.
      const result = await statement(selectCategorySuggestionsPlan(limit + 1)).all<Row>()
      const rows = result.results.slice(0, limit).map(
        (row): CategorySuggestionRow => ({
          categoryName: optionalText(row.category_name),
          createdAt: toInstant(row.created_at),
          id: text(row.id),
          kind: text(row.kind) === 'revision' ? 'revision' : 'submission',
          listingName: text(row.listing_name),
          name: text(row.name),
          note: optionalText(row.note),
          status: text(row.status)
        })
      )
      return { rows, truncated: result.results.length > limit }
    },

    async listActiveCategories() {
      const result = await statement(selectActiveCategoriesPlan()).all<Row>()
      return result.results.map(row => ({ name: text(row.name), slug: text(row.slug) }))
    },

    async listActiveTags() {
      const result = await statement(selectActiveTagsPlan()).all<Row>()
      return result.results.map(row => ({
        category: text(row.category),
        categoryName: text(row.category_name),
        name: text(row.name),
        slug: text(row.slug)
      }))
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
        paymentLoss: toPaymentLoss(row.payment_loss),
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
