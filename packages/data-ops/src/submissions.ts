import { isValidAssetReference } from '@serpdirectory/site-contract/asset-reference'
import { and, eq, or, sql } from 'drizzle-orm'
import type { CompiledSiteQuery, SiteDatabase } from './client'
import type { ListingDetail } from './contracts'
import {
  assertCutoverUnlockedPlan,
  CutoverFrozenError,
  hasActiveCutoverLock,
  selectActiveCutoverLockPlan
} from './cutover-lock'
import { validatePublicHttpUrl } from './public-url'
import {
  categories,
  listingSubmissionEvents,
  listingSubmissionFaqs,
  listingSubmissionNotifications,
  listingSubmissionRateLimits,
  listingSubmissionResourceLinks,
  listingSubmissions,
  listings
} from './schema'
import { assertPreviousStatementChangedOne } from './submission-plans'

const MAX_ATTEMPTS = 10
const COOLDOWN_SECONDS = 30
const SUBMISSION_WINDOW_SECONDS = 60 * 60
const SUBMISSION_WINDOW_LIMIT = 10
const REVIEW_CHANNEL = 'github_issue'
const CONTENT_VERIFICATION_FAILURES = new Set(['badge_missing', 'nofollow', 'wrong_destination'])
const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

export class SubmissionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message)
  }
}

export function isSubmissionError(
  error: unknown
): error is Error & { code: string; status: number } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}

export interface SubmissionInput {
  category: string
  content: string
  description: string
  faqs: Array<{ answer: string; question: string }>
  logoUrl: string
  name: string
  resourceLinks: Array<{ label: string; url: string }>
  videoUrl?: string
  website: string
}

export interface SubmissionState {
  badgeVerifiedAt: string | null
  id: string
  lastVerificationError: string | null
  name: string
  slug: string
  status: 'approved' | 'pending_badge' | 'rejected' | 'verified'
  verificationAttempts: number
  website: string
}

export type SubmissionVerificationResult =
  | { ok: true }
  | {
      code: string
      ok: false
    }

export interface SubmissionOperations {
  beginVerification(id: string, token: string): Promise<SubmissionState>
  consumeRateLimit(fingerprint: string): Promise<void>
  createSubmission(input: SubmissionInput): Promise<SubmissionState & { token: string }>
  finishVerification(
    id: string,
    token: string,
    result: SubmissionVerificationResult
  ): Promise<SubmissionState>
  getReviewPreview(access: { id: string; token: string }): Promise<ListingDetail | null>
  getSubmission(id: string, token: string): Promise<SubmissionState>
}

interface SubmissionRow {
  badge_verified_at: string | null
  id: string
  last_verification_at: string | null
  last_verification_error: string | null
  name: string
  slug: string
  status: SubmissionState['status']
  verification_attempts: number
  website: string
}

export interface SubmissionReviewPreviewRow {
  category_slug: string
  content: string
  created_at: string
  description: string
  id: string
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

function prepare(client: SiteDatabase, query: CompiledSiteQuery): D1PreparedStatement {
  const compiled = query.toSQL()
  return client.binding.prepare(compiled.sql).bind(...compiled.params)
}

function prepareRaw(client: SiteDatabase, text: string, params: unknown[]): D1PreparedStatement {
  return client.binding.prepare(text).bind(...params)
}

function toState(row: SubmissionRow): SubmissionState {
  return {
    badgeVerifiedAt: row.badge_verified_at,
    id: row.id,
    lastVerificationError: row.last_verification_error,
    name: row.name,
    slug: row.slug,
    status: row.status,
    verificationAttempts: row.verification_attempts,
    website: row.website
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function submissionSlug(website: string): string {
  return new URL(website).hostname.replace(/^www\./u, '').toLowerCase()
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
  const logo = assetReference(row.logo_url, 'logo URL')
  const video = row.video_url ? assetReference(row.video_url, 'video URL') : undefined
  const resourceLinks = resources.map((resource, index) => ({
    label: requiredTrimmedText(resource.label, `resource ${index + 1} label`),
    url: absoluteUrl(resource.url, `resource ${index + 1} URL`)
  }))
  return {
    categories: [category],
    category,
    content: requiredText(row.content, 'content'),
    description: requiredTrimmedText(row.description, 'description'),
    media: {
      logo,
      ...(video ? { video } : {})
    },
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

function validClock(clock: () => Date): Date {
  const value = clock()
  if (Number.isNaN(value.getTime())) throw new Error('Submission clock returned an invalid date.')
  return value
}

export function createSubmissionOperations(config: {
  client: SiteDatabase
  clock?: () => Date
}): SubmissionOperations {
  const { client } = config
  const clock = config.clock ?? (() => new Date())
  const { siteId } = client

  async function queryFirst<T>(query: CompiledSiteQuery): Promise<T | null> {
    const result = await prepare(client, query).first<T>()
    return result ?? null
  }

  async function throwIfCutoverLocked(): Promise<void> {
    const plan = selectActiveCutoverLockPlan(siteId)
    const result = await prepareRaw(client, plan.sql, plan.params).all<Record<string, unknown>>()
    if (hasActiveCutoverLock(result.results ?? [])) throw new CutoverFrozenError()
  }

  function cutoverGuard(): D1PreparedStatement {
    const plan = assertCutoverUnlockedPlan(siteId)
    return prepareRaw(client, plan.sql, plan.params)
  }

  async function authorizedRow(id: string, token: string): Promise<SubmissionRow> {
    const row = await queryFirst<SubmissionRow>(
      client.database
        .select({
          badge_verified_at: listingSubmissions.badgeVerifiedAt,
          id: listingSubmissions.id,
          last_verification_at: listingSubmissions.lastVerificationAt,
          last_verification_error: listingSubmissions.lastVerificationError,
          name: listingSubmissions.name,
          slug: listingSubmissions.slug,
          status: listingSubmissions.status,
          verification_attempts: listingSubmissions.verificationAttempts,
          website: listingSubmissions.website
        })
        .from(listingSubmissions)
        .where(
          and(
            eq(listingSubmissions.id, id),
            eq(listingSubmissions.siteId, siteId),
            eq(listingSubmissions.accessTokenHash, await sha256(token))
          )
        )
        .limit(1)
    )
    if (!row) throw new SubmissionError('not_found', 'Submission not found.', 404)
    return row
  }

  async function getSubmission(id: string, token: string): Promise<SubmissionState> {
    return toState(await authorizedRow(id, token))
  }

  return {
    async createSubmission(input) {
      await throwIfCutoverLocked()
      for (const value of [
        input.website,
        input.logoUrl,
        input.videoUrl,
        ...input.resourceLinks.map(link => link.url)
      ]) {
        if (value && !validatePublicHttpUrl(value).ok) {
          throw new SubmissionError(
            'invalid_url',
            'All submitted URLs must be public HTTP(S) URLs.'
          )
        }
      }
      const slug = submissionSlug(input.website)
      const [category, existing] = await Promise.all([
        queryFirst(
          client.database
            .select({ id: categories.id })
            .from(categories)
            .where(
              and(
                eq(categories.siteId, siteId),
                eq(categories.slug, input.category),
                eq(categories.isActive, true)
              )
            )
            .limit(1)
        ),
        queryFirst(
          client.database
            .select({ id: listings.id })
            .from(listings)
            .where(
              and(
                eq(listings.siteId, siteId),
                or(eq(listings.slug, slug), eq(listings.website, input.website))
              )
            )
            .limit(1)
        )
      ])
      if (!category) throw new SubmissionError('invalid_category', 'Choose an active category.')
      if (existing)
        throw new SubmissionError('listing_exists', 'This website is already listed.', 409)

      const id = crypto.randomUUID()
      const tokenBytes = new Uint8Array(32)
      crypto.getRandomValues(tokenBytes)
      const token = bytesToBase64Url(tokenBytes)
      const tokenHash = await sha256(token)
      const statements = [
        cutoverGuard(),
        prepare(
          client,
          client.database.insert(listingSubmissions).values({
            accessTokenHash: tokenHash,
            categorySlug: input.category,
            content: input.content,
            description: input.description,
            id,
            logoUrl: input.logoUrl,
            name: input.name,
            siteId,
            slug,
            videoUrl: input.videoUrl || null,
            website: input.website
          })
        ),
        ...input.resourceLinks.map((link, index) =>
          prepare(
            client,
            client.database.insert(listingSubmissionResourceLinks).values({
              label: link.label,
              sortOrder: index,
              submissionId: id,
              url: link.url
            })
          )
        ),
        ...input.faqs.map((faq, index) =>
          prepare(
            client,
            client.database.insert(listingSubmissionFaqs).values({
              answer: faq.answer,
              question: faq.question,
              sortOrder: index,
              submissionId: id
            })
          )
        ),
        prepare(
          client,
          client.database.insert(listingSubmissionEvents).values({
            actor: 'public-form',
            eventType: 'created',
            submissionId: id
          })
        )
      ]
      try {
        const results = await client.binding.batch(statements)
        if (results.some(result => !result.success)) throw new Error('D1 batch failed.')
      } catch {
        await throwIfCutoverLocked()
        throw new SubmissionError(
          'duplicate_submission',
          'A submission for this website is already awaiting review.',
          409
        )
      }
      return {
        badgeVerifiedAt: null,
        id,
        lastVerificationError: null,
        name: input.name,
        slug,
        status: 'pending_badge',
        token,
        verificationAttempts: 0,
        website: input.website
      }
    },

    async consumeRateLimit(fingerprint) {
      await throwIfCutoverLocked()
      const fingerprintHash = await sha256(`${siteId}:${fingerprint}`)
      const now = Math.floor(validClock(clock).getTime() / 1000)
      const windowStart = now - SUBMISSION_WINDOW_SECONDS
      const statements = [
        cutoverGuard(),
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
        await throwIfCutoverLocked()
        throw new Error('D1 submission rate limit failed.')
      }
      const count = results[2]?.results?.[0]?.request_count
      if (typeof count !== 'number') throw new Error('D1 submission rate limit failed.')
      if (count > SUBMISSION_WINDOW_LIMIT) {
        throw new SubmissionError('rate_limited', 'Too many submissions. Try again later.', 429)
      }
    },

    getSubmission,

    async beginVerification(id, token) {
      await throwIfCutoverLocked()
      const row = await authorizedRow(id, token)
      if (row.status !== 'pending_badge') return toState(row)
      const lastFailureWasConclusive =
        !row.last_verification_error ||
        CONTENT_VERIFICATION_FAILURES.has(row.last_verification_error)
      if (row.verification_attempts >= MAX_ATTEMPTS && lastFailureWasConclusive) {
        throw new SubmissionError('attempt_limit', 'Badge verification attempt limit reached.', 429)
      }
      if (
        row.last_verification_at &&
        validClock(clock).getTime() - Date.parse(`${row.last_verification_at.replace(' ', 'T')}Z`) <
          COOLDOWN_SECONDS * 1000
      ) {
        throw new SubmissionError('cooldown', 'Wait 30 seconds before checking again.', 429)
      }
      return toState(row)
    },

    async finishVerification(id, token, result) {
      await throwIfCutoverLocked()
      const row = await authorizedRow(id, token)
      if (row.status !== 'pending_badge') return toState(row)
      const tokenHash = await sha256(token)
      const status = result.ok ? 'verified' : 'pending_badge'
      const error = result.ok ? null : result.code
      const attemptIncrement = result.ok || CONTENT_VERIFICATION_FAILURES.has(result.code) ? 1 : 0
      const statements = [
        cutoverGuard(),
        prepareRaw(
          client,
          `UPDATE listing_submissions SET status=?, verification_attempts=verification_attempts+?,
            last_verification_at=CURRENT_TIMESTAMP,last_verification_error=?,
            badge_verified_at=CASE WHEN ?='verified' THEN CURRENT_TIMESTAMP ELSE badge_verified_at END,
            updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND site_id=? AND access_token_hash=? AND status='pending_badge'
            AND verification_attempts=? AND last_verification_at IS ?`,
          [
            status,
            attemptIncrement,
            error,
            status,
            id,
            siteId,
            tokenHash,
            row.verification_attempts,
            row.last_verification_at
          ]
        ),
        prepareRaw(client, assertPreviousStatementChangedOne('verification_state_changed').sql, []),
        prepareRaw(
          client,
          `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
          VALUES (?,?,?,'badge-verifier')`,
          [id, result.ok ? 'badge_verified' : 'verification_failed', error]
        )
      ]
      let results: D1Result<unknown>[]
      try {
        results = await client.binding.batch(statements)
      } catch {
        await throwIfCutoverLocked()
        throw new Error('D1 verification update failed.')
      }
      if (results.some(item => !item.success)) throw new Error('D1 verification update failed.')
      return getSubmission(id, token)
    },

    async getReviewPreview(access) {
      const tokenHash = await sha256(access.token)
      const submission = await queryFirst<SubmissionReviewPreviewRow>(
        client.database
          .select({
            category_slug: listingSubmissions.categorySlug,
            content: listingSubmissions.content,
            created_at: listingSubmissions.createdAt,
            description: listingSubmissions.description,
            id: listingSubmissions.id,
            logo_url: listingSubmissions.logoUrl,
            name: listingSubmissions.name,
            slug: listingSubmissions.slug,
            video_url: listingSubmissions.videoUrl,
            website: listingSubmissions.website
          })
          .from(listingSubmissions)
          .innerJoin(
            listingSubmissionNotifications,
            and(
              eq(listingSubmissionNotifications.submissionId, listingSubmissions.id),
              eq(listingSubmissionNotifications.channel, REVIEW_CHANNEL)
            )
          )
          .where(
            and(
              eq(listingSubmissions.id, access.id),
              eq(listingSubmissions.siteId, siteId),
              eq(listingSubmissions.status, 'verified'),
              eq(listingSubmissionNotifications.previewTokenHash, tokenHash)
            )
          )
          .limit(1)
      )
      if (!submission) return null
      const resourceResult = await prepare(
        client,
        client.database
          .select({
            label: listingSubmissionResourceLinks.label,
            sort_order: listingSubmissionResourceLinks.sortOrder,
            url: listingSubmissionResourceLinks.url
          })
          .from(listingSubmissionResourceLinks)
          .where(eq(listingSubmissionResourceLinks.submissionId, submission.id))
          .orderBy(listingSubmissionResourceLinks.sortOrder, listingSubmissionResourceLinks.id)
      ).all<SubmissionReviewPreviewResourceRow>()
      if (!resourceResult.success) throw new Error('D1 submission review preview query failed.')
      return buildSubmissionReviewPreview(submission, resourceResult.results)
    }
  }
}
