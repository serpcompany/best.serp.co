import { isValidAssetReference } from '@/lib/asset-reference'
import { hasFileExtension } from '@/lib/file-extensions'
import { type UrlKey, urlKey } from '@/lib/url-key'
import { and, eq, sql } from 'drizzle-orm'
import type { CompiledQuery, Database } from './client'
import type { ListingDetail } from './contracts'
import { toInstant } from './instants'
import { listingIdsWithWebsite } from './listing-plans'
import { isMediaKey, mediaUrl } from './media-keys'
import { validatePublicHttpUrl } from './public-url'
import {
  categories,
  listingSubmissionRateLimits,
  type SubmissionPlan,
  type SubmissionStatus
} from './schema'
import {
  assertPreviousStatementChangedOne,
  buildChooseSubmissionPlanPlans,
  buildReplaceSubmissionContentPlans,
  type SubmissionStatementPlan
} from './submission-plans'

/**
 * Native submission intake (serpcompany/best.serp.co#59, #63): a signed-in owner saves a draft,
 * chooses a plan, and verifies the badge. Every read and write is scoped to the owner's user id;
 * there is no anonymous access. Transitions use the reviewed statement plans in
 * `submission-plans.ts` (see docs/SUBMISSION_FLOW.md).
 */

/** Badge checks per submission that can find a conclusive result (missing, nofollow, ...). */
export const VERIFICATION_MAX_ATTEMPTS = 10
/** Seconds between two badge checks of one submission. */
export const VERIFICATION_COOLDOWN_SECONDS = 30
/** Draft saves per owner per hour. */
export const SUBMISSION_WINDOW_LIMIT = 10
const SUBMISSION_WINDOW_SECONDS = 60 * 60

/** Field limits, mirrored by the form contract in `apps/web/src/lib/submissions/contract.ts`. */
export const SUBMISSION_LIMITS = {
  content: 5000,
  description: 160,
  name: 120
} as const

/**
 * Check results that read the page and found a problem; each uses up one of the ten checks.
 * `nofollow` is the code stored before `link_not_followed` (#84).
 */
export const CONCLUSIVE_VERIFICATION_FAILURES = [
  'badge_missing',
  'link_not_followed',
  'nofollow',
  'page_not_followed',
  'wrong_destination'
] as const
const CONTENT_VERIFICATION_FAILURES = new Set<string>(CONCLUSIVE_VERIFICATION_FAILURES)
const CONCLUSIVE_SQL_LIST = CONCLUSIVE_VERIFICATION_FAILURES.map(code => `'${code}'`).join(',')
const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

export class SubmissionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /** Why a URL cannot be submitted, for duplicate and blocked answers. */
    public readonly availability?: UrlAvailability
  ) {
    super(message)
  }
}

export function isSubmissionError(
  error: unknown
): error is Error & { availability?: UrlAvailability; code: string; status: number } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}

/** What a draft holds besides its website, which never changes after the first save. */
export interface DraftContent {
  categorySlug: string
  /** The optional long description (Markdown); empty when not given. */
  content: string
  /** The short description, at most 160 characters. */
  description: string
  logoUrl: string
  name: string
}

export interface NewDraftInput extends DraftContent {
  website: string
}

/** Whether a website can be submitted, and if not, why (docs/SUBMISSION_FLOW.md). */
export type UrlAvailability =
  | { kind: 'available'; slug: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'blocked'; slug: string }
  | {
      kind: 'listed'
      listing: {
        categoryName: string | null
        logoUrl: string | null
        name: string
        /** False for an unpublished listing (its URL answers 410). */
        public: boolean
        slug: string
      }
    }
  | {
      kind: 'pending'
      /** The owner's own submission, so the form can link to it; null for someone else's. */
      mine: { id: string; status: SubmissionStatus } | null
      slug: string
    }

export interface OwnSubmission {
  badgeVerifiedAt: string | null
  categoryName: string | null
  categorySlug: string
  content: string
  contentVersion: number
  createdAt: string
  description: string
  draftSavedAt: string | null
  id: string
  lastVerificationAt: string | null
  lastVerificationError: string | null
  logoUrl: string
  name: string
  plan: SubmissionPlan | null
  slug: string
  status: SubmissionStatus
  verificationAttempts: number
  website: string
}

export type SubmissionVerificationResult = { ok: true } | { code: string; ok: false }

export interface SubmissionOperations {
  /**
   * Claims one badge check in a single compare-and-swap, before anything is fetched: the
   * submission must be the owner's, waiting for its badge, past the 30-second cooldown, and
   * under the ten-check cap. Throws `not_found` (404), `not_pending_badge` (409),
   * `attempt_limit` (429), or `cooldown` (429). Pass `claimedAt` to `finishVerification`.
   */
  claimVerification(
    id: string,
    ownerUserId: string
  ): Promise<{ claimedAt: string; submission: OwnSubmission }>
  checkUrl(website: string, ownerUserId?: string | null): Promise<UrlAvailability>
  /** `draft` → `pending_badge` with the free plan (`buildChooseSubmissionPlanPlans`). */
  chooseFreePlan(id: string, ownerUserId: string): Promise<OwnSubmission>
  consumeRateLimit(fingerprint: string): Promise<void>
  createDraft(input: { ownerUserId: string; submission: NewDraftInput }): Promise<OwnSubmission>
  /**
   * Records the claimed check's result, compare-and-swapping on `claimedAt`. A check whose claim
   * was overtaken (a later claim after the cooldown) throws `verification_superseded` (409).
   */
  finishVerification(
    id: string,
    ownerUserId: string,
    claimedAt: string,
    result: SubmissionVerificationResult
  ): Promise<OwnSubmission>
  getOwnSubmission(id: string, ownerUserId: string): Promise<OwnSubmission | null>
  listOwnSubmissions(ownerUserId: string, limit?: number): Promise<OwnSubmission[]>
  updateDraft(input: {
    content: DraftContent
    expectedContentVersion: number
    ownerUserId: string
    submissionId: string
  }): Promise<OwnSubmission>
}

interface OwnSubmissionRow {
  badge_verified_at: string | null
  category_name: string | null
  category_slug: string
  content: string
  content_version: number
  created_at: string
  description: string
  draft_saved_at: string | null
  id: string
  last_verification_at: string | null
  last_verification_error: string | null
  logo_url: string
  name: string
  plan: SubmissionPlan | null
  slug: string
  status: SubmissionStatus
  verification_attempts: number
  website: string
}

export interface SubmissionReviewPreviewRow {
  category_slug: string
  content: string
  created_at: string
  description: string
  id: string
  /**
   * The submission's hosted featured image (#95), if any: the image approval would publish, and
   * the only one the preview shows (#96 round 2 B1).
   */
  image_key?: string | null
  /** The submission's hosted copy of `logo_url` (#95), if any: the only logo the preview shows. */
  logo_key?: string | null
  logo_url: string
  name: string
  slug: string
  video_url: string | null
  website: string
}

export interface SubmissionReviewPreviewResourceRow {
  label: string
  sort_order: number
  url: string
}

function prepare(client: Database, query: CompiledQuery): D1PreparedStatement {
  const compiled = query.toSQL()
  return client.binding.prepare(compiled.sql).bind(...compiled.params)
}

function prepareRaw(client: Database, text: string, params: unknown[]): D1PreparedStatement {
  return client.binding.prepare(text).bind(...params)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

const OWN_SUBMISSION_COLUMNS = `s.id,s.slug,s.name,s.description,s.website,s.content,s.category_slug,
  c.name AS category_name,s.logo_url,s.status,s.plan,s.draft_saved_at,s.badge_verified_at,
  s.verification_attempts,s.last_verification_at,s.last_verification_error,s.content_version,
  s.created_at`

function toOwnSubmission(row: OwnSubmissionRow): OwnSubmission {
  return {
    badgeVerifiedAt: row.badge_verified_at,
    categoryName: row.category_name,
    categorySlug: row.category_slug,
    content: row.content,
    contentVersion: row.content_version,
    createdAt: row.created_at,
    description: row.description,
    draftSavedAt: row.draft_saved_at,
    id: row.id,
    lastVerificationAt: row.last_verification_at,
    lastVerificationError: row.last_verification_error,
    logoUrl: row.logo_url,
    name: row.name,
    plan: row.plan,
    slug: row.slug,
    status: row.status,
    verificationAttempts: row.verification_attempts,
    website: row.website
  }
}

/**
 * The URL key of a submitted website, or an `invalid` answer. One normalization serves the
 * slug, the duplicate check, and the prohibited-URL block (`urlKey()`).
 */
function keyOf(website: string): UrlKey | { message: string } {
  if (!validatePublicHttpUrl(website).ok) {
    return { message: 'Enter a public website address that starts with http:// or https://.' }
  }
  let key: UrlKey
  try {
    key = urlKey(website)
  } catch {
    return { message: 'Enter a public website address that starts with http:// or https://.' }
  }
  // `/products/<slug>/` must stay a page URL; a slug ending in a file extension (`chart.js`)
  // would be treated as a file and lose its trailing slash.
  if (hasFileExtension(key.hostKey)) {
    return { message: 'This website address can’t be listed: it ends in a file extension.' }
  }
  return key
}

/**
 * An active prohibited-URL block that covers the host: one on the host itself, or a
 * subdomain-covering block on a parent domain of the host. Mirrors the
 * `listing_submissions_refuse_blocked_url` trigger, which enforces the same rule on insert.
 */
export function selectActiveUrlBlockStatement(key: UrlKey): { params: unknown[]; sql: string } {
  return {
    sql: `SELECT id FROM listing_submission_url_blocks
      WHERE lifted_at IS NULL
        AND (url_key=? OR (covers_subdomains=1 AND substr(?, -1 - length(url_key))='.' || url_key))
      LIMIT 1`,
    params: [key.hostKey, key.hostKey]
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid D1 submission preview ${field}.`)
  }
  return value
}

function requiredTrimmedText(value: unknown, field: string): string {
  const text = requiredText(value, field).trim()
  if (!text) throw new Error(`Invalid D1 submission preview ${field}.`)
  return text
}

function absoluteUrl(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (!validatePublicHttpUrl(text).ok) throw new Error(`Invalid D1 submission preview ${field}.`)
  return text
}

function assetReference(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (!isValidAssetReference(text)) {
    throw new Error(`Invalid D1 submission preview ${field}.`)
  }
  return text
}

export function buildSubmissionReviewPreview(
  row: SubmissionReviewPreviewRow,
  resources: SubmissionReviewPreviewResourceRow[]
): ListingDetail {
  const category = requiredTrimmedText(row.category_slug, 'category')
  const createdAt = requiredText(row.created_at, 'created date')
  const publishedAt = createdAt.slice(0, 10)
  if (!PUBLISHED_AT_PATTERN.test(publishedAt)) {
    throw new Error('Invalid D1 submission preview publication date.')
  }
  if (typeof row.content !== 'string') throw new Error('Invalid D1 submission preview content.')
  // The source is still checked, but never rendered: the preview shows the hosted copy's key
  // (the web adapter resolves it on the media host), or the fallback tile (#96 review S9).
  assetReference(row.logo_url, 'logo URL')
  const logo = row.logo_key && isMediaKey(row.logo_key) ? row.logo_key : undefined
  const image = row.image_key && isMediaKey(row.image_key) ? row.image_key : undefined
  const video = row.video_url ? assetReference(row.video_url, 'video URL') : undefined
  const resourceLinks = resources.map((resource, index) => ({
    label: requiredTrimmedText(resource.label, `resource ${index + 1} label`),
    url: absoluteUrl(resource.url, `resource ${index + 1} URL`)
  }))
  return {
    categories: [category],
    category,
    // The long description is optional (#63).
    content: row.content,
    description: requiredTrimmedText(row.description, 'description'),
    media: {
      ...(image ? { images: [image] } : {}),
      ...(logo ? { logo } : {}),
      ...(video ? { video } : {})
    },
    // New submissions are listed with a nofollow outbound link (#59); preview it that way.
    linkRel: 'nofollow',
    // A preview has never been public, so it last changed when it was created.
    modifiedAt: toInstant(createdAt) ?? `${publishedAt}T00:00:00.000Z`,
    name: requiredTrimmedText(row.name, 'name'),
    nextWebsite: null,
    previousWebsite: null,
    publishedAt,
    relatedWebsites: [],
    resourceLinks,
    slug: requiredTrimmedText(row.slug, 'slug'),
    website: absoluteUrl(row.website, 'website URL')
  }
}

/** `YYYY-MM-DD HH:MM:SS` (UTC), the `CURRENT_TIMESTAMP` format of the verification columns. */
function sqliteTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ')
}

function validClock(clock: () => Date): Date {
  const value = clock()
  if (Number.isNaN(value.getTime())) throw new Error('Submission clock returned an invalid date.')
  return value
}

/**
 * Checks a draft's content before it is written; the form contract checks the same rules.
 * Logos must be https (PR #84 review round 1, finding 6): they are hotlinked on https pages.
 * A local Worker also accepts http, for the fixture websites of the end-to-end tests.
 */
export function validateDraftContent(
  content: DraftContent,
  allowInsecureLogos: boolean
): DraftContent {
  const name = content.name.trim()
  const description = content.description.trim()
  const body = content.content.trim()
  const categorySlug = content.categorySlug.trim()
  const logoUrl = content.logoUrl.trim()
  if (!name || name.length > SUBMISSION_LIMITS.name) {
    throw new SubmissionError('invalid_name', 'Enter the product name.')
  }
  if (!description || description.length > SUBMISSION_LIMITS.description) {
    throw new SubmissionError(
      'invalid_description',
      `Keep the short description to ${SUBMISSION_LIMITS.description} characters or fewer.`
    )
  }
  if (body.length > SUBMISSION_LIMITS.content) {
    throw new SubmissionError('invalid_content', 'The long description is too long.')
  }
  if (!categorySlug) throw new SubmissionError('invalid_category', 'Choose a primary category.')
  const logo = logoUrl ? validatePublicHttpUrl(logoUrl) : null
  if (!logo?.ok) {
    throw new SubmissionError('invalid_logo', 'Add a logo with a public image address.')
  }
  if (logo.url.protocol !== 'https:' && !allowInsecureLogos) {
    throw new SubmissionError('invalid_logo', 'Use an image address that starts with https://.')
  }
  return { categorySlug, content: body, description, logoUrl, name }
}

async function runPlans(client: Database, plans: SubmissionStatementPlan[]): Promise<boolean> {
  try {
    const results = await client.binding.batch(
      plans.map(plan => prepareRaw(client, plan.sql, plan.params))
    )
    return results.every(result => result.success)
  } catch {
    return false
  }
}

export function createSubmissionOperations(config: {
  /** Accept http logo URLs (a local Worker only); every other environment requires https. */
  allowInsecureLogos?: boolean
  client: Database
  clock?: () => Date
  /** The environment's media host (`MEDIA_BASE_URL`): a listed listing's logo is shown from it. */
  mediaBaseUrl?: string
}): SubmissionOperations {
  const { client, mediaBaseUrl } = config
  const allowInsecureLogos = config.allowInsecureLogos === true
  const clock = config.clock ?? (() => new Date())

  async function queryFirst<T>(query: CompiledQuery): Promise<T | null> {
    const result = await prepare(client, query).first<T>()
    return result ?? null
  }

  async function getOwnSubmission(id: string, ownerUserId: string): Promise<OwnSubmission | null> {
    const row = await prepareRaw(
      client,
      `SELECT ${OWN_SUBMISSION_COLUMNS}
        FROM listing_submissions s LEFT JOIN categories c ON c.slug=s.category_slug
        WHERE s.id=? AND s.owner_user_id=? LIMIT 1`,
      [id, ownerUserId]
    ).first<OwnSubmissionRow>()
    return row ? toOwnSubmission(row) : null
  }

  async function requireOwnSubmission(id: string, ownerUserId: string): Promise<OwnSubmission> {
    const submission = await getOwnSubmission(id, ownerUserId)
    if (!submission) throw new SubmissionError('not_found', 'Submission not found.', 404)
    return submission
  }

  async function checkKey(
    key: UrlKey,
    website: string,
    ownerUserId: string | null
  ): Promise<UrlAvailability> {
    const slug = key.hostKey
    const block = selectActiveUrlBlockStatement(key)
    // The admin website edit matches listings with the same rule (`listingWebsiteMatch`).
    const listed = listingIdsWithWebsite(website)
    const [blocked, listing, pending] = await Promise.all([
      prepareRaw(client, block.sql, block.params).first(),
      prepareRaw(
        client,
        `SELECT l.slug,l.name,l.status,l.is_active,
            (SELECT c.name FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
              WHERE lc.listing_id=l.id AND lc.is_primary=1 LIMIT 1) AS category_name,
            (SELECT m.media_key FROM listing_media m WHERE m.listing_id=l.id AND m.kind='logo'
              AND m.media_key IS NOT NULL ORDER BY m.sort_order LIMIT 1) AS logo_key
          FROM listings l WHERE l.id IN (${listed.sql}) ORDER BY l.slug<>? LIMIT 1`,
        [...listed.params, slug]
      ).first<{
        category_name: string | null
        is_active: number
        logo_key: string | null
        name: string
        slug: string
        status: string
      }>(),
      prepareRaw(
        client,
        `SELECT id,status,owner_user_id FROM listing_submissions
          WHERE slug=? AND status IN ('draft','pending_badge','verified','paid_pending_review',
            'changes_requested')
          LIMIT 1`,
        [slug]
      ).first<{ id: string; owner_user_id: string | null; status: SubmissionStatus }>()
    ])
    if (blocked) return { kind: 'blocked', slug }
    if (listing) {
      return {
        kind: 'listed',
        listing: {
          categoryName: listing.category_name,
          // The hosted copy on this environment's media host, never a source URL (#95).
          logoUrl:
            listing.logo_key && mediaBaseUrl ? mediaUrl(listing.logo_key, mediaBaseUrl) : null,
          name: listing.name,
          public: listing.status === 'approved' && Number(listing.is_active) === 1,
          slug: listing.slug
        }
      }
    }
    if (pending) {
      const mine = ownerUserId !== null && pending.owner_user_id === ownerUserId
      return {
        kind: 'pending',
        mine: mine ? { id: pending.id, status: pending.status } : null,
        slug
      }
    }
    return { kind: 'available', slug }
  }

  function unavailableError(availability: UrlAvailability): SubmissionError {
    switch (availability.kind) {
      case 'invalid':
        return new SubmissionError('invalid_url', availability.message, 400, availability)
      case 'blocked':
        return new SubmissionError(
          'url_blocked',
          'This website can’t be submitted.',
          403,
          availability
        )
      case 'listed':
        return new SubmissionError(
          'listing_exists',
          'This website is already listed.',
          409,
          availability
        )
      case 'pending':
        return new SubmissionError(
          'duplicate_submission',
          'This website is already submitted.',
          409,
          availability
        )
      default:
        return new SubmissionError('unavailable', 'This website can’t be submitted.', 409)
    }
  }

  return {
    async checkUrl(website, ownerUserId = null) {
      const key = keyOf(website.trim())
      if (!('hostKey' in key)) return { kind: 'invalid', message: key.message }
      return checkKey(key, website.trim(), ownerUserId)
    },

    async createDraft({ ownerUserId, submission }) {
      const website = submission.website.trim()
      const key = keyOf(website)
      if (!('hostKey' in key)) {
        throw unavailableError({ kind: 'invalid', message: key.message })
      }
      const content = validateDraftContent(submission, allowInsecureLogos)
      const [category, availability] = await Promise.all([
        queryFirst(
          client.database
            .select({ id: categories.id })
            .from(categories)
            .where(and(eq(categories.slug, content.categorySlug), eq(categories.isActive, true)))
            .limit(1)
        ),
        checkKey(key, website, ownerUserId)
      ])
      if (!category) throw new SubmissionError('invalid_category', 'Choose a primary category.')
      if (availability.kind !== 'available') throw unavailableError(availability)

      const id = crypto.randomUUID()
      const now = validClock(clock).toISOString()
      const saved = await runPlans(client, [
        {
          // A draft is native (#62 contract): owner, block key and scope, no plan, and the
          // draft clock from this first save, which edits never reset.
          sql: `INSERT INTO listing_submissions
            (id,slug,name,description,website,content,category_slug,logo_url,status,plan,
              owner_user_id,draft_saved_at,block_key,block_covers_subdomains)
            VALUES (?,?,?,?,?,?,?,?,'draft',NULL,?,?,?,?)`,
          params: [
            id,
            key.hostKey,
            content.name,
            content.description,
            website,
            content.content,
            content.categorySlug,
            content.logoUrl,
            ownerUserId,
            now,
            key.blockKey,
            key.coversSubdomains ? 1 : 0
          ]
        },
        {
          sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
            VALUES (?,'created',NULL,?)`,
          params: [id, ownerUserId]
        }
      ])
      if (!saved) {
        // Lost a race with another submission of the same URL key, or a block added meanwhile
        // (the active-slug index and the block trigger refuse the insert).
        const latest = await checkKey(key, website, ownerUserId)
        throw latest.kind === 'available'
          ? new Error('D1 draft insert failed.')
          : unavailableError(latest)
      }
      return requireOwnSubmission(id, ownerUserId)
    },

    async updateDraft({ content, expectedContentVersion, ownerUserId, submissionId }) {
      const checked = validateDraftContent(content, allowInsecureLogos)
      const current = await requireOwnSubmission(submissionId, ownerUserId)
      if (current.status !== 'draft' && current.status !== 'pending_badge') {
        throw new SubmissionError(
          'not_editable',
          'This submission can no longer be edited here.',
          409
        )
      }
      const category = await queryFirst(
        client.database
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.slug, checked.categorySlug), eq(categories.isActive, true)))
          .limit(1)
      )
      if (!category) throw new SubmissionError('invalid_category', 'Choose a primary category.')
      const updated = await runPlans(
        client,
        buildReplaceSubmissionContentPlans({
          actor: ownerUserId,
          content: {
            categorySlug: checked.categorySlug,
            content: checked.content,
            description: checked.description,
            // Submit v2 collects no FAQs or links; they are added later from the dashboard (#65).
            faqs: [],
            logoUrl: checked.logoUrl,
            name: checked.name,
            resourceLinks: []
          },
          expectedContentVersion,
          expectedStatuses: [current.status],
          now: validClock(clock).toISOString(),
          ownerUserId,
          submissionId
        })
      )
      if (!updated) {
        throw new SubmissionError(
          'stale_submission',
          'This submission changed in another window. Reload and try again.',
          409
        )
      }
      return requireOwnSubmission(submissionId, ownerUserId)
    },

    getOwnSubmission,

    async listOwnSubmissions(ownerUserId, limit = 50) {
      const rows = await prepareRaw(
        client,
        `SELECT ${OWN_SUBMISSION_COLUMNS}
          FROM listing_submissions s LEFT JOIN categories c ON c.slug=s.category_slug
          WHERE s.owner_user_id=?
          ORDER BY s.created_at DESC,s.id
          LIMIT ?`,
        [ownerUserId, Math.max(1, Math.min(limit, 200))]
      ).all<OwnSubmissionRow>()
      if (!rows.success) throw new Error('D1 submissions query failed.')
      return rows.results.map(toOwnSubmission)
    },

    async chooseFreePlan(id, ownerUserId) {
      const current = await requireOwnSubmission(id, ownerUserId)
      if (current.status !== 'draft') {
        throw new SubmissionError('plan_not_available', 'A plan is already chosen.', 409)
      }
      const chosen = await runPlans(
        client,
        buildChooseSubmissionPlanPlans({
          now: validClock(clock).toISOString(),
          ownerUserId,
          plan: 'free',
          submissionId: id
        })
      )
      if (!chosen) {
        throw new SubmissionError(
          'plan_not_available',
          'This draft can no longer choose a plan.',
          409
        )
      }
      return requireOwnSubmission(id, ownerUserId)
    },

    async consumeRateLimit(fingerprint) {
      const fingerprintHash = await sha256(fingerprint)
      const now = Math.floor(validClock(clock).getTime() / 1000)
      const windowStart = now - SUBMISSION_WINDOW_SECONDS
      const statements = [
        prepare(
          client,
          client.database
            .insert(listingSubmissionRateLimits)
            .values({ fingerprintHash, requestCount: 1, windowStartedAt: now })
            .onConflictDoUpdate({
              set: {
                requestCount: sql`CASE WHEN ${listingSubmissionRateLimits.windowStartedAt}<=${windowStart} THEN 1 ELSE ${listingSubmissionRateLimits.requestCount}+1 END`,
                windowStartedAt: sql`CASE WHEN ${listingSubmissionRateLimits.windowStartedAt}<=${windowStart} THEN ${now} ELSE ${listingSubmissionRateLimits.windowStartedAt} END`
              },
              target: listingSubmissionRateLimits.fingerprintHash
            })
        ),
        prepare(
          client,
          client.database
            .select({ request_count: listingSubmissionRateLimits.requestCount })
            .from(listingSubmissionRateLimits)
            .where(eq(listingSubmissionRateLimits.fingerprintHash, fingerprintHash))
            .limit(1)
        )
      ]
      let results: D1Result<{ request_count?: number }>[]
      try {
        results = await client.binding.batch<{ request_count?: number }>(statements)
      } catch {
        throw new Error('D1 submission rate limit failed.')
      }
      const count = results[1]?.results?.[0]?.request_count
      if (typeof count !== 'number') throw new Error('D1 submission rate limit failed.')
      if (count > SUBMISSION_WINDOW_LIMIT) {
        throw new SubmissionError('rate_limited', 'Too many submissions. Try again later.', 429)
      }
    },

    async claimVerification(id, ownerUserId) {
      const now = validClock(clock)
      const claimedAt = sqliteTimestamp(now)
      const cooldownCutoff = sqliteTimestamp(
        new Date(now.getTime() - VERIFICATION_COOLDOWN_SECONDS * 1000)
      )
      let changes = 0
      try {
        const result = await prepareRaw(
          client,
          `UPDATE listing_submissions SET last_verification_at=?,updated_at=?
            WHERE id=? AND owner_user_id=? AND status='pending_badge'
              AND (last_verification_at IS NULL OR last_verification_at<=?)
              AND NOT (verification_attempts>=? AND (last_verification_error IS NULL
                OR last_verification_error IN (${CONCLUSIVE_SQL_LIST})))`,
          [claimedAt, now.toISOString(), id, ownerUserId, cooldownCutoff, VERIFICATION_MAX_ATTEMPTS]
        ).run()
        changes = Number(result.meta?.changes ?? 0)
      } catch {
        throw new Error('D1 verification claim failed.')
      }
      const submission = await requireOwnSubmission(id, ownerUserId)
      if (changes === 1) return { claimedAt, submission }
      if (submission.status !== 'pending_badge') {
        throw new SubmissionError(
          'not_pending_badge',
          'This submission isn’t waiting for its badge.',
          409
        )
      }
      const lastFailureWasConclusive =
        !submission.lastVerificationError ||
        CONTENT_VERIFICATION_FAILURES.has(submission.lastVerificationError)
      if (
        submission.verificationAttempts >= VERIFICATION_MAX_ATTEMPTS &&
        lastFailureWasConclusive
      ) {
        throw new SubmissionError('attempt_limit', 'Badge verification attempt limit reached.', 429)
      }
      throw new SubmissionError('cooldown', 'Wait 30 seconds before checking again.', 429)
    },

    async finishVerification(id, ownerUserId, claimedAt, result) {
      const status = result.ok ? 'verified' : 'pending_badge'
      const error = result.ok ? null : result.code
      const attemptIncrement = result.ok || CONTENT_VERIFICATION_FAILURES.has(result.code) ? 1 : 0
      const now = validClock(clock)
      const recorded = await runPlans(client, [
        {
          sql: `UPDATE listing_submissions SET status=?,verification_attempts=verification_attempts+?,
              last_verification_error=?,
              badge_verified_at=CASE WHEN ?='verified' THEN ? ELSE badge_verified_at END,
              updated_at=?
            WHERE id=? AND owner_user_id=? AND status='pending_badge' AND last_verification_at=?`,
          params: [
            status,
            attemptIncrement,
            error,
            status,
            sqliteTimestamp(now),
            now.toISOString(),
            id,
            ownerUserId,
            claimedAt
          ]
        },
        assertPreviousStatementChangedOne('verification_recorded'),
        {
          sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
            VALUES (?,?,?,'badge-verifier')`,
          params: [id, result.ok ? 'badge_verified' : 'verification_failed', error]
        }
      ])
      if (!recorded) {
        throw new SubmissionError(
          'verification_superseded',
          'Another check of this badge finished first. Reload to see its result.',
          409
        )
      }
      return requireOwnSubmission(id, ownerUserId)
    }
  }
}
