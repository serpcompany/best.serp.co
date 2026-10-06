import type { Database } from './client'
import { MAX_STAGED_FAQS, MAX_STAGED_RESOURCE_LINKS, type StatementPlan } from './plan-support'
import { validatePublicHttpUrl } from './public-url'
import {
  buildCreateRevisionPlans,
  buildReplaceRevisionContentPlans,
  buildResubmitRevisionPlans,
  buildWithdrawRevisionPlans
} from './revision-plans'
import type { RejectionCategory, RevisionStatus, SubmissionPlan, SubmissionStatus } from './schema'
import {
  buildClaimListingBadgeCheckPlans,
  buildFinishListingBadgeCheckPlans,
  buildReplaceSubmissionContentPlans,
  buildReplaceSubmissionExtrasPlans,
  buildResubmitSubmissionPlans,
  buildWithdrawSubmissionPlans
} from './submission-plans'
import {
  CONCLUSIVE_VERIFICATION_FAILURES,
  type DraftContent,
  SUBMISSION_LIMITS,
  SubmissionError,
  VERIFICATION_COOLDOWN_SECONDS,
  VERIFICATION_MAX_ATTEMPTS,
  validateDraftContent
} from './submissions'

/**
 * The submitter dashboard's reads and writes (serpcompany/best.serp.co#65). Every statement is
 * scoped to the signed-in user in SQL: a submission by `owner_user_id`, a listing by a current
 * `listing_owners` row, a revision by `author_user_id`. Someone else's id reads as missing, so
 * the app answers 404 and ids reveal nothing. Writes are the reviewed statement plans
 * (`submission-plans.ts`, `revision-plans.ts`), each one batch.
 */

/** Per listing or submission (`plan-support.ts` caps a batch at five of each). */
export const ACCOUNT_LIMITS = {
  faqAnswer: 1000,
  faqQuestion: 200,
  faqs: MAX_STAGED_FAQS,
  linkLabel: 60,
  links: MAX_STAGED_RESOURCE_LINKS,
  linkUrl: 2048
} as const

/** Rows per list; a submitter has a handful. */
const LIST_LIMIT = 200
/** Badge history entries per listing. */
const HISTORY_LIMIT = 10

export interface AccountFaq {
  answer: string
  question: string
}

export interface AccountLink {
  label: string
  url: string
}

export interface AccountExtras {
  faqs: AccountFaq[]
  resourceLinks: AccountLink[]
}

export interface AccountEvent {
  actor: string | null
  at: string
  detail: string | null
  type: string
}

export interface AccountSubmission {
  badgeVerifiedAt: string | null
  categoryName: string | null
  categorySlug: string
  contentVersion: number
  createdAt: string
  description: string
  draftSavedAt: string | null
  id: string
  lastVerificationAt: string | null
  lastVerificationError: string | null
  /** The listing a paid or approved submission published, and whether it is up. */
  listing: { live: boolean; slug: string } | null
  logoUrl: string
  name: string
  paidAt: string | null
  plan: SubmissionPlan | null
  refundedAt: string | null
  rejection: { category: RejectionCategory | null; reason: string } | null
  reviewedAt: string | null
  reviewerNote: string | null
  slug: string
  status: SubmissionStatus
  updatedAt: string
  verificationAttempts: number
  website: string
  withdrawalReason: 'admin' | 'expired' | 'owner' | null
}

export interface AccountSubmissionDetail extends AccountSubmission, AccountExtras {
  content: string
  events: AccountEvent[]
  videoUrl: string | null
}

/** One badge check: the owner's from the account, or the badge program's (#66). */
export interface AccountBadgeCheck {
  at: string
  by: 'owner' | 'program'
  conclusive: boolean
  outcome: 'fail' | 'pass'
  reason: string | null
}

/** A live free listing's badge, checked from its approved submission's counters. */
export interface AccountListingBadge {
  history: AccountBadgeCheck[]
  lastCheckAt: string | null
  lastError: string | null
  submissionId: string
  verificationAttempts: number
}

export interface AccountRevision {
  contentVersion: number
  createdAt: string
  id: string
  rejectionReason: string | null
  reviewedAt: string | null
  reviewerNote: string | null
  status: RevisionStatus
  updatedAt: string
}

export interface AccountRevisionDetail extends AccountRevision, AccountExtras {
  categoryName: string | null
  categorySlug: string
  content: string
  description: string
  logoUrl: string
  name: string
}

export interface AccountListing {
  /** Null unless the listing is on the free plan through its approved submission. */
  badge: AccountListingBadge | null
  categoryName: string | null
  categorySlug: string | null
  description: string
  id: string
  live: boolean
  logoUrl: string | null
  name: string
  plan: SubmissionPlan | null
  publishedAt: string | null
  /** The user's latest revision of the listing, open or decided. */
  revision: AccountRevision | null
  slug: string
  /** The user's latest submission for the listing. */
  submission: { id: string; status: SubmissionStatus } | null
  verifiedVia: string
  website: string
}

export interface AccountListingDetail extends AccountListing, AccountExtras {
  content: string
  revision: AccountRevisionDetail | null
  videoUrl: string | null
}

export interface AccountOverview {
  listings: AccountListing[]
  submissions: AccountSubmission[]
}

/** What an owner may change in a live listing (#70 screen 7): never its name or website. */
export interface RevisionContent extends AccountExtras {
  categorySlug: string
  content: string
  description: string
  logoUrl: string
}

type Row = Record<string, unknown>

/**
 * D1 rows hold `CURRENT_TIMESTAMP` defaults (`YYYY-MM-DD HH:MM:SS`, UTC), dates, and ISO
 * instants written by plans. All become ISO instants.
 */
export function accountInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
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

function optional(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

const SUBMISSION_COLUMNS = `s.id,s.slug,s.name,s.description,s.website,s.logo_url,s.category_slug,
  c.name AS category_name,s.status,s.plan,s.created_at,s.updated_at,s.draft_saved_at,s.listing_id,
  l.slug AS listing_slug,
  CASE WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
    THEN 1 ELSE 0 END AS listing_live,
  s.paid_at,s.refunded_at,s.reviewer_note,s.reviewed_at,s.rejection_reason,s.rejection_category,
  s.withdrawal_reason,s.badge_verified_at,s.verification_attempts,s.last_verification_at,
  s.last_verification_error,s.content_version`

const SUBMISSION_FROM = `FROM listing_submissions s LEFT JOIN categories c ON c.slug=s.category_slug
  LEFT JOIN listings l ON l.id=s.listing_id`

/** A current owner row of the listing `l` for the user bound at `?1`. */
const OWNED = `EXISTS (SELECT 1 FROM listing_owners o WHERE o.listing_id=l.id AND o.user_id=?1
  AND o.role='owner' AND o.revoked_at IS NULL)`

const LISTING_COLUMNS = `l.id,l.slug,l.name,l.description,l.website,l.is_active,l.status,
  l.published_at,
  CASE WHEN l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL
    THEN 1 ELSE 0 END AS live,
  (SELECT m.url FROM listing_media m WHERE m.listing_id=l.id AND m.kind='logo'
    ORDER BY m.sort_order LIMIT 1) AS logo_url,
  (SELECT pc.slug FROM listing_categories lc JOIN categories pc ON pc.id=lc.category_id
    WHERE lc.listing_id=l.id AND lc.is_primary=1 LIMIT 1) AS category_slug,
  (SELECT pc.name FROM listing_categories lc JOIN categories pc ON pc.id=lc.category_id
    WHERE lc.listing_id=l.id AND lc.is_primary=1 LIMIT 1) AS category_name,
  (SELECT o.verified_via FROM listing_owners o WHERE o.listing_id=l.id AND o.user_id=?1
    AND o.role='owner' AND o.revoked_at IS NULL LIMIT 1) AS verified_via,
  s.id AS submission_id,s.status AS submission_status,s.plan,s.paid_at,s.refunded_at,
  s.verification_attempts,s.last_verification_at,s.last_verification_error,
  r.id AS revision_id,r.status AS revision_status,r.created_at AS revision_created_at,
  r.updated_at AS revision_updated_at,r.reviewer_note AS revision_note,
  r.rejection_reason AS revision_rejection_reason,r.reviewed_at AS revision_reviewed_at,
  r.content_version AS revision_content_version`

/** The user's latest submission (`s`) and latest revision (`r`) of each listing `l`. */
const LISTING_JOINS = `LEFT JOIN listing_submissions s ON s.id=(SELECT x.id FROM listing_submissions x
    WHERE x.listing_id=l.id AND x.owner_user_id=?1 ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
  LEFT JOIN listing_revisions r ON r.id=(SELECT y.id FROM listing_revisions y
    WHERE y.listing_id=l.id AND y.author_user_id=?1 ORDER BY y.created_at DESC,y.id DESC LIMIT 1)`

/**
 * Badge history of the user's listings: the owner's checks from the account (events on the
 * listing's submission) and the badge program's (`badge_checks`), newest first.
 */
function badgeHistoryPlan(userId: string, slug: string | null): StatementPlan {
  const listingFilter = slug === null ? '' : ' AND l.slug=?2'
  return {
    sql: `SELECT listing_id,at,by,outcome,reason,conclusive FROM (
        SELECT s.listing_id,strftime('%Y-%m-%dT%H:%M:%fZ',e.created_at) AS at,'owner' AS by,
          CASE WHEN e.event_type='badge_verified' THEN 'pass' ELSE 'fail' END AS outcome,
          e.detail AS reason,
          CASE WHEN e.event_type='badge_verified'
            OR e.detail IN (SELECT value FROM json_each(?3)) THEN 1 ELSE 0 END AS conclusive,
          e.id AS sort_id
        FROM listing_submission_events e JOIN listing_submissions s ON s.id=e.submission_id
          JOIN listings l ON l.id=s.listing_id
        WHERE s.owner_user_id=?1 AND e.event_type IN ('badge_verified','verification_failed')
          AND ${OWNED}${listingFilter}
        UNION ALL
        SELECT b.listing_id,b.checked_at AS at,'program' AS by,b.outcome,b.reason,b.conclusive,
          b.id AS sort_id
        FROM badge_checks b JOIN listings l ON l.id=b.listing_id
        WHERE ${OWNED}${listingFilter})
      ORDER BY at DESC,sort_id DESC LIMIT ${slug === null ? LIST_LIMIT : HISTORY_LIMIT}`,
    params: [userId, slug ?? '', JSON.stringify(CONCLUSIVE_VERIFICATION_FAILURES)]
  }
}

export function selectAccountOverviewPlans(userId: string): StatementPlan[] {
  return [
    {
      sql: `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM}
        WHERE s.owner_user_id=? ORDER BY s.created_at DESC,s.id LIMIT ${LIST_LIMIT}`,
      params: [userId]
    },
    {
      sql: `SELECT ${LISTING_COLUMNS} FROM listings l ${LISTING_JOINS}
        WHERE l.status='approved' AND ${OWNED} ORDER BY l.name COLLATE NOCASE,l.id
        LIMIT ${LIST_LIMIT}`,
      params: [userId]
    },
    badgeHistoryPlan(userId, null)
  ]
}

export function selectAccountSubmissionPlans(
  userId: string,
  submissionId: string
): StatementPlan[] {
  const own = `SELECT id FROM listing_submissions WHERE id=? AND owner_user_id=?`
  return [
    {
      sql: `SELECT ${SUBMISSION_COLUMNS},s.content,s.video_url ${SUBMISSION_FROM}
        WHERE s.id=? AND s.owner_user_id=?`,
      params: [submissionId, userId]
    },
    {
      sql: `SELECT label,url FROM listing_submission_resource_links
        WHERE submission_id=(${own}) ORDER BY sort_order`,
      params: [submissionId, userId]
    },
    {
      sql: `SELECT question,answer FROM listing_submission_faqs
        WHERE submission_id=(${own}) ORDER BY sort_order`,
      params: [submissionId, userId]
    },
    {
      sql: `SELECT event_type,detail,actor,created_at FROM listing_submission_events
        WHERE submission_id=(${own}) ORDER BY created_at DESC,id DESC LIMIT 50`,
      params: [submissionId, userId]
    }
  ]
}

export function selectAccountListingPlans(userId: string, slug: string): StatementPlan[] {
  const listing = `SELECT l.id FROM listings l WHERE l.slug=?2 AND l.status='approved' AND ${OWNED}`
  const revision = `SELECT y.id FROM listing_revisions y WHERE y.listing_id=(${listing})
    AND y.author_user_id=?1 ORDER BY y.created_at DESC,y.id DESC LIMIT 1`
  return [
    {
      sql: `SELECT ${LISTING_COLUMNS},l.content,
          (SELECT m.url FROM listing_media m WHERE m.listing_id=l.id AND m.kind='video'
            ORDER BY m.sort_order LIMIT 1) AS video_url
        FROM listings l ${LISTING_JOINS}
        WHERE l.slug=?2 AND l.status='approved' AND ${OWNED}`,
      params: [userId, slug]
    },
    {
      sql: `SELECT label,url FROM listing_resource_links WHERE listing_id=(${listing})
        ORDER BY sort_order`,
      params: [userId, slug]
    },
    {
      sql: `SELECT question,answer FROM listing_faqs WHERE listing_id=(${listing})
        ORDER BY sort_order`,
      params: [userId, slug]
    },
    {
      sql: `SELECT r.name,r.description,r.content,r.category_slug,c.name AS category_name,
          r.logo_url FROM listing_revisions r LEFT JOIN categories c ON c.slug=r.category_slug
        WHERE r.id=(${revision})`,
      params: [userId, slug]
    },
    {
      sql: `SELECT label,url FROM listing_revision_resource_links WHERE revision_id=(${revision})
        ORDER BY sort_order`,
      params: [userId, slug]
    },
    {
      sql: `SELECT question,answer FROM listing_revision_faqs WHERE revision_id=(${revision})
        ORDER BY sort_order`,
      params: [userId, slug]
    },
    badgeHistoryPlan(userId, slug)
  ]
}

function toSubmission(row: Row): AccountSubmission {
  const listingSlug = optional(row.listing_slug)
  const rejectionReason = optional(row.rejection_reason)
  return {
    badgeVerifiedAt: accountInstant(row.badge_verified_at),
    categoryName: optional(row.category_name),
    categorySlug: text(row.category_slug),
    contentVersion: Number(row.content_version ?? 1),
    createdAt: accountInstant(row.created_at) ?? '',
    description: text(row.description),
    draftSavedAt: accountInstant(row.draft_saved_at),
    id: text(row.id),
    lastVerificationAt: accountInstant(row.last_verification_at),
    lastVerificationError: optional(row.last_verification_error),
    listing: listingSlug ? { live: Number(row.listing_live) === 1, slug: listingSlug } : null,
    logoUrl: text(row.logo_url),
    name: text(row.name),
    paidAt: accountInstant(row.paid_at),
    plan: (optional(row.plan) as SubmissionPlan | null) ?? null,
    refundedAt: accountInstant(row.refunded_at),
    rejection:
      text(row.status) === 'rejected' && rejectionReason
        ? {
            category: (optional(row.rejection_category) as RejectionCategory | null) ?? null,
            reason: rejectionReason
          }
        : null,
    reviewedAt: accountInstant(row.reviewed_at),
    reviewerNote: optional(row.reviewer_note),
    slug: text(row.slug),
    status: text(row.status) as SubmissionStatus,
    updatedAt: accountInstant(row.updated_at) ?? '',
    verificationAttempts: Number(row.verification_attempts ?? 0),
    website: text(row.website),
    withdrawalReason:
      (optional(row.withdrawal_reason) as AccountSubmission['withdrawalReason']) ?? null
  }
}

function toBadgeCheck(row: Row): AccountBadgeCheck {
  return {
    at: accountInstant(row.at) ?? '',
    by: row.by === 'program' ? 'program' : 'owner',
    conclusive: Number(row.conclusive) === 1,
    outcome: row.outcome === 'pass' ? 'pass' : 'fail',
    reason: optional(row.reason)
  }
}

function toListing(row: Row, history: AccountBadgeCheck[]): AccountListing {
  const submissionId = optional(row.submission_id)
  const plan = (optional(row.plan) as SubmissionPlan | null) ?? null
  const revisionId = optional(row.revision_id)
  const free =
    submissionId !== null &&
    plan === 'free' &&
    row.paid_at === null &&
    text(row.submission_status) === 'approved'
  return {
    badge: free
      ? {
          history,
          lastCheckAt: accountInstant(row.last_verification_at),
          lastError: optional(row.last_verification_error),
          submissionId,
          verificationAttempts: Number(row.verification_attempts ?? 0)
        }
      : null,
    categoryName: optional(row.category_name),
    categorySlug: optional(row.category_slug),
    description: text(row.description),
    id: text(row.id),
    live: Number(row.live) === 1,
    logoUrl: optional(row.logo_url),
    name: text(row.name),
    plan: submissionId ? plan : row.verified_via === 'paid_claim' ? 'paid' : null,
    publishedAt: accountInstant(row.published_at),
    revision: revisionId
      ? {
          contentVersion: Number(row.revision_content_version ?? 1),
          createdAt: accountInstant(row.revision_created_at) ?? '',
          id: revisionId,
          rejectionReason: optional(row.revision_rejection_reason),
          reviewedAt: accountInstant(row.revision_reviewed_at),
          reviewerNote: optional(row.revision_note),
          status: text(row.revision_status) as RevisionStatus,
          updatedAt: accountInstant(row.revision_updated_at) ?? ''
        }
      : null,
    slug: text(row.slug),
    submission: submissionId
      ? { id: submissionId, status: text(row.submission_status) as SubmissionStatus }
      : null,
    verifiedVia: text(row.verified_via),
    website: text(row.website)
  }
}

function links(rows: Row[]): AccountLink[] {
  return rows.map(row => ({ label: text(row.label), url: text(row.url) }))
}

function faqs(rows: Row[]): AccountFaq[] {
  return rows.map(row => ({ answer: text(row.answer), question: text(row.question) }))
}

/** Trims and checks FAQs and links an owner entered (`ACCOUNT_LIMITS`, https links only). */
export function validateExtras(extras: AccountExtras): AccountExtras {
  if (extras.faqs.length > ACCOUNT_LIMITS.faqs) {
    throw new SubmissionError('invalid_faqs', `Add at most ${ACCOUNT_LIMITS.faqs} FAQs.`)
  }
  if (extras.resourceLinks.length > ACCOUNT_LIMITS.links) {
    throw new SubmissionError('invalid_links', `Add at most ${ACCOUNT_LIMITS.links} links.`)
  }
  const checkedFaqs = extras.faqs.map(faq => {
    const question = faq.question.trim()
    const answer = faq.answer.trim()
    if (!question || question.length > ACCOUNT_LIMITS.faqQuestion) {
      throw new SubmissionError(
        'invalid_faqs',
        'Each FAQ needs a question of 200 characters or fewer.'
      )
    }
    if (!answer || answer.length > ACCOUNT_LIMITS.faqAnswer) {
      throw new SubmissionError(
        'invalid_faqs',
        'Each FAQ needs an answer of 1,000 characters or fewer.'
      )
    }
    return { answer, question }
  })
  const checkedLinks = extras.resourceLinks.map(link => {
    const label = link.label.trim()
    const url = link.url.trim()
    if (!label || label.length > ACCOUNT_LIMITS.linkLabel) {
      throw new SubmissionError(
        'invalid_links',
        'Each link needs a label of 60 characters or fewer.'
      )
    }
    const checked = url.length <= ACCOUNT_LIMITS.linkUrl ? validatePublicHttpUrl(url) : null
    if (!checked?.ok || checked.url.protocol !== 'https:') {
      throw new SubmissionError('invalid_links', 'Enter a full URL starting with https://')
    }
    return { label, url }
  })
  return { faqs: checkedFaqs, resourceLinks: checkedLinks }
}

function sqliteTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ')
}

export interface AccountOperations {
  /**
   * Claims one badge check of the user's live free listing (the badge step's cooldown and cap).
   * Throws `not_found` (404), `not_checkable` (409), `attempt_limit` (429), or `cooldown` (429).
   */
  claimListingBadgeCheck(input: {
    listingId: string
    userId: string
  }): Promise<{ claimedAt: string; listing: AccountListing }>
  /** Withdraws the user's open revision of a listing. */
  discardRevision(input: { listingId: string; userId: string }): Promise<void>
  /** Records a claimed check; `verification_superseded` (409) when a later claim overtook it. */
  finishListingBadgeCheck(input: {
    claimedAt: string
    conclusive: boolean
    result: { ok: true } | { code: string; ok: false }
    submissionId: string
    userId: string
  }): Promise<void>
  listing(userId: string, slug: string): Promise<AccountListingDetail | null>
  /** The user's listing by id, or null (someone else's reads as missing). */
  listingById(userId: string, listingId: string): Promise<AccountListingDetail | null>
  overview(userId: string): Promise<AccountOverview>
  /**
   * Saves the owner's edits of a changes-requested submission and sends it back to the review
   * queue it left, in one batch (`stale_submission`, 409, when it changed meanwhile).
   */
  resubmitSubmission(input: {
    content: DraftContent
    expectedContentVersion: number
    submissionId: string
    userId: string
  }): Promise<AccountSubmissionDetail>
  /**
   * Stages the owner's edits of a live listing: a new revision, or the open one replaced (and
   * sent back to review when changes were requested). Returns the revision and whether it
   * (re)entered the review queue.
   */
  saveRevision(input: {
    content: RevisionContent
    listingId: string
    newRevisionId: string
    userId: string
  }): Promise<{ queued: boolean; revisionId: string }>
  /** Replaces the FAQs and links of a submission waiting for review. */
  saveSubmissionExtras(input: {
    expectedContentVersion: number
    extras: AccountExtras
    submissionId: string
    userId: string
  }): Promise<AccountSubmissionDetail>
  submission(userId: string, submissionId: string): Promise<AccountSubmissionDetail | null>
  withdrawSubmission(input: { submissionId: string; userId: string }): Promise<void>
}

export function createAccountOperations(config: {
  /** Accept http logo URLs (a local Worker only), as submit v2 does. */
  allowInsecureLogos?: boolean
  client: Database
  clock?: () => Date
}): AccountOperations {
  const db = config.client.binding
  const clock = config.clock ?? (() => new Date())
  const statement = (plan: StatementPlan) => db.prepare(plan.sql).bind(...plan.params)

  function now(): Date {
    const value = clock()
    if (Number.isNaN(value.getTime())) throw new Error('Account clock returned an invalid date.')
    return value
  }

  async function read(plans: StatementPlan[]): Promise<Row[][]> {
    const results = await db.batch<Row>(plans.map(statement))
    return results.map(result => result.results ?? [])
  }

  /** One batch; false when a compare-and-swap or constraint refused it. */
  async function write(plans: StatementPlan[]): Promise<boolean> {
    try {
      const results = await db.batch(plans.map(statement))
      return results.every(result => result.success)
    } catch {
      return false
    }
  }

  async function submission(userId: string, submissionId: string) {
    const [rows, linkRows, faqRows, eventRows] = await read(
      selectAccountSubmissionPlans(userId, submissionId)
    )
    const row = rows?.[0]
    if (!row) return null
    return {
      ...toSubmission(row),
      content: text(row.content),
      events: (eventRows ?? []).map(event => ({
        actor: optional(event.actor),
        at: accountInstant(event.created_at) ?? '',
        detail: optional(event.detail),
        type: text(event.event_type)
      })),
      faqs: faqs(faqRows ?? []),
      resourceLinks: links(linkRows ?? []),
      videoUrl: optional(row.video_url)
    }
  }

  async function requireSubmission(userId: string, submissionId: string) {
    const current = await submission(userId, submissionId)
    if (!current) throw new SubmissionError('not_found', 'Submission not found.', 404)
    return current
  }

  async function listing(userId: string, slug: string): Promise<AccountListingDetail | null> {
    const [rows, linkRows, faqRows, revisionRows, revisionLinks, revisionFaqs, history] =
      await read(selectAccountListingPlans(userId, slug))
    const row = rows?.[0]
    if (!row) return null
    const base = toListing(row, (history ?? []).map(toBadgeCheck))
    const staged = revisionRows?.[0]
    return {
      ...base,
      content: text(row.content),
      faqs: faqs(faqRows ?? []),
      resourceLinks: links(linkRows ?? []),
      revision:
        base.revision && staged
          ? {
              ...base.revision,
              categoryName: optional(staged.category_name),
              categorySlug: text(staged.category_slug),
              content: text(staged.content),
              description: text(staged.description),
              faqs: faqs(revisionFaqs ?? []),
              logoUrl: text(staged.logo_url),
              name: text(staged.name),
              resourceLinks: links(revisionLinks ?? [])
            }
          : null,
      videoUrl: optional(row.video_url)
    }
  }

  async function findListingById(
    userId: string,
    listingId: string
  ): Promise<AccountListingDetail | null> {
    const [rows] = await read([
      {
        sql: `SELECT l.slug FROM listings l WHERE l.id=?2 AND l.status='approved' AND ${OWNED}`,
        params: [userId, listingId]
      }
    ])
    const slug = optional(rows?.[0]?.slug)
    return slug ? listing(userId, slug) : null
  }

  async function listingById(userId: string, listingId: string) {
    const found = await findListingById(userId, listingId)
    if (!found) throw new SubmissionError('not_found', 'Listing not found.', 404)
    return found
  }

  async function activeCategory(slug: string): Promise<boolean> {
    const [rows] = await read([
      { sql: 'SELECT 1 AS found FROM categories WHERE slug=? AND is_active=1', params: [slug] }
    ])
    return (rows?.length ?? 0) > 0
  }

  return {
    async claimListingBadgeCheck({ listingId, userId }) {
      const current = await listingById(userId, listingId)
      if (!current.badge || !current.live) {
        throw new SubmissionError(
          'not_checkable',
          'Only a live free listing’s badge can be checked here.',
          409
        )
      }
      const at = now()
      const claimedAt = sqliteTimestamp(at)
      const claimed = await write(
        buildClaimListingBadgeCheckPlans({
          claimedAt,
          conclusiveCodes: CONCLUSIVE_VERIFICATION_FAILURES,
          cooldownCutoff: sqliteTimestamp(
            new Date(at.getTime() - VERIFICATION_COOLDOWN_SECONDS * 1000)
          ),
          maxAttempts: VERIFICATION_MAX_ATTEMPTS,
          now: at.toISOString(),
          ownerUserId: userId,
          submissionId: current.badge.submissionId
        })
      )
      const fresh = await listingById(userId, listingId)
      if (claimed) return { claimedAt, listing: fresh }
      const badge = fresh.badge
      if (!badge || !fresh.live) {
        throw new SubmissionError(
          'not_checkable',
          'Only a live free listing’s badge can be checked here.',
          409
        )
      }
      const conclusiveLast =
        badge.lastError === null ||
        (CONCLUSIVE_VERIFICATION_FAILURES as readonly string[]).includes(badge.lastError)
      if (badge.verificationAttempts >= VERIFICATION_MAX_ATTEMPTS && conclusiveLast) {
        throw new SubmissionError('attempt_limit', 'Badge verification attempt limit reached.', 429)
      }
      throw new SubmissionError('cooldown', 'Wait 30 seconds before checking again.', 429)
    },

    async discardRevision({ listingId, userId }) {
      const current = await listingById(userId, listingId)
      const revision = current.revision
      if (
        !revision ||
        (revision.status !== 'pending_review' && revision.status !== 'changes_requested')
      ) {
        throw new SubmissionError('no_open_revision', 'There are no pending edits to discard.', 409)
      }
      const done = await write(
        buildWithdrawRevisionPlans({
          authorUserId: userId,
          now: now().toISOString(),
          revisionId: revision.id
        })
      )
      if (!done) {
        throw new SubmissionError(
          'stale_revision',
          'Your edits changed in another window. Reload and try again.',
          409
        )
      }
    },

    async finishListingBadgeCheck({ claimedAt, conclusive, result, submissionId, userId }) {
      const recorded = await write(
        buildFinishListingBadgeCheckPlans({
          claimedAt,
          conclusive,
          now: now().toISOString(),
          ownerUserId: userId,
          result,
          submissionId
        })
      )
      if (!recorded) {
        throw new SubmissionError(
          'verification_superseded',
          'Another check of this badge finished first. Reload to see its result.',
          409
        )
      }
    },

    listing,

    listingById: findListingById,

    async overview(userId) {
      const [submissionRows, listingRows, historyRows] = await read(
        selectAccountOverviewPlans(userId)
      )
      const history = new Map<string, AccountBadgeCheck[]>()
      for (const row of historyRows ?? []) {
        const id = text(row.listing_id)
        const entries = history.get(id) ?? []
        if (entries.length < HISTORY_LIMIT) entries.push(toBadgeCheck(row))
        history.set(id, entries)
      }
      return {
        listings: (listingRows ?? []).map(row => toListing(row, history.get(text(row.id)) ?? [])),
        submissions: (submissionRows ?? []).map(toSubmission)
      }
    },

    async resubmitSubmission({ content, expectedContentVersion, submissionId, userId }) {
      const current = await requireSubmission(userId, submissionId)
      if (current.status !== 'changes_requested') {
        throw new SubmissionError(
          'not_editable',
          'Only a submission with requested changes can be resubmitted.',
          409
        )
      }
      const checked = validateDraftContent(content, config.allowInsecureLogos === true)
      if (!(await activeCategory(checked.categorySlug))) {
        throw new SubmissionError('invalid_category', 'Choose a primary category.')
      }
      const at = now().toISOString()
      const edited = (
        ['name', 'description', 'content', 'categorySlug', 'logoUrl'] as const
      ).filter(field => checked[field] !== current[field])
      const done = await write([
        ...buildReplaceSubmissionContentPlans({
          actor: userId,
          content: {
            ...checked,
            faqs: current.faqs,
            resourceLinks: current.resourceLinks,
            videoUrl: current.videoUrl
          },
          eventDetail: JSON.stringify({ fields: edited }),
          expectedContentVersion,
          expectedStatuses: ['changes_requested'],
          now: at,
          ownerUserId: userId,
          submissionId
        }),
        ...buildResubmitSubmissionPlans({ now: at, ownerUserId: userId, submissionId })
      ])
      if (!done) {
        const fresh = await requireSubmission(userId, submissionId)
        throw fresh.status === 'changes_requested' &&
          fresh.contentVersion === expectedContentVersion &&
          fresh.listing !== null &&
          !fresh.listing.live
          ? new SubmissionError(
              'listing_down',
              'Your listing was taken down, so this can’t be resubmitted. Message us.',
              409
            )
          : new SubmissionError(
              'stale_submission',
              'This submission changed in another window. Reload and try again.',
              409
            )
      }
      return requireSubmission(userId, submissionId)
    },

    async saveRevision({ content, listingId, newRevisionId, userId }) {
      const current = await listingById(userId, listingId)
      if (!current.live) {
        throw new SubmissionError('not_editable', 'Only a live listing can be edited.', 409)
      }
      if (
        current.submission &&
        ['paid_pending_review', 'changes_requested'].includes(current.submission.status)
      ) {
        throw new SubmissionError(
          'submission_in_review',
          'This listing’s submission is still in review. Edit it there.',
          409
        )
      }
      const description = content.description.trim()
      const body = content.content.trim()
      const categorySlug = content.categorySlug.trim()
      if (!description || description.length > SUBMISSION_LIMITS.description) {
        throw new SubmissionError(
          'invalid_description',
          `Keep the short description to ${SUBMISSION_LIMITS.description} characters or fewer.`
        )
      }
      if (body.length > SUBMISSION_LIMITS.content) {
        throw new SubmissionError('invalid_content', 'The long description is too long.')
      }
      if (!categorySlug || !(await activeCategory(categorySlug))) {
        throw new SubmissionError('invalid_category', 'Choose a primary category.')
      }
      const open =
        current.revision &&
        (current.revision.status === 'pending_review' ||
          current.revision.status === 'changes_requested')
          ? current.revision
          : null
      // A logo the edit leaves alone is kept as stored (an imported listing may hold a
      // site-relative one); a changed logo must be a public https image address.
      const unchangedLogo = [current.logoUrl, open?.logoUrl].includes(content.logoUrl.trim())
      const logoUrl = content.logoUrl.trim()
      if (!unchangedLogo) {
        const logo = logoUrl ? validatePublicHttpUrl(logoUrl) : null
        if (!logo?.ok || (logo.url.protocol !== 'https:' && config.allowInsecureLogos !== true)) {
          throw new SubmissionError(
            'invalid_logo',
            'Use an image address that starts with https://.'
          )
        }
      }
      if (!logoUrl) throw new SubmissionError('invalid_logo', 'Add a logo.')
      const extras = validateExtras(content)
      const staged = {
        categorySlug,
        content: body,
        description,
        faqs: extras.faqs,
        logoUrl,
        name: current.name,
        resourceLinks: extras.resourceLinks,
        videoUrl: current.videoUrl
      }
      const at = now().toISOString()
      const revisionId = open?.id ?? newRevisionId
      const plans = open
        ? [
            ...buildReplaceRevisionContentPlans({
              authorUserId: userId,
              content: staged,
              now: at,
              revisionId
            }),
            ...(open.status === 'changes_requested'
              ? buildResubmitRevisionPlans({ authorUserId: userId, now: at, revisionId })
              : [])
          ]
        : buildCreateRevisionPlans({
            authorUserId: userId,
            content: staged,
            listingId,
            now: at,
            revisionId
          })
      if (!(await write(plans))) {
        throw new SubmissionError(
          'stale_revision',
          'This listing changed in another window. Reload and try again.',
          409
        )
      }
      return { queued: !open || open.status === 'changes_requested', revisionId }
    },

    async saveSubmissionExtras({ expectedContentVersion, extras, submissionId, userId }) {
      const current = await requireSubmission(userId, submissionId)
      if (current.status !== 'verified' && current.status !== 'paid_pending_review') {
        throw new SubmissionError(
          'not_editable',
          'FAQs and links can be added here while the submission waits for review.',
          409
        )
      }
      const done = await write(
        buildReplaceSubmissionExtrasPlans({
          content: validateExtras(extras),
          expectedContentVersion,
          now: now().toISOString(),
          ownerUserId: userId,
          submissionId
        })
      )
      if (!done) {
        throw new SubmissionError(
          'stale_submission',
          'This submission changed in another window. Reload and try again.',
          409
        )
      }
      return requireSubmission(userId, submissionId)
    },

    submission,

    async withdrawSubmission({ submissionId, userId }) {
      const current = await requireSubmission(userId, submissionId)
      if (current.paidAt !== null || current.listing !== null) {
        throw new SubmissionError(
          'not_withdrawable',
          'A paid submission can’t be withdrawn. Message us and we’ll sort it out.',
          409
        )
      }
      if (!['draft', 'pending_badge', 'verified', 'changes_requested'].includes(current.status)) {
        throw new SubmissionError('not_withdrawable', 'This submission can’t be withdrawn.', 409)
      }
      const done = await write(
        buildWithdrawSubmissionPlans({
          now: now().toISOString(),
          ownerUserId: userId,
          submissionId
        })
      )
      if (!done) {
        const fresh = await requireSubmission(userId, submissionId)
        if (fresh.status === 'withdrawn') return
        throw new SubmissionError(
          'stale_submission',
          'This submission changed in another window. Reload and try again.',
          409
        )
      }
    }
  }
}
