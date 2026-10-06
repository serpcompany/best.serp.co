import { type HostedMedia, isMediaKey, MEDIA_KINDS, type MediaKind } from './media-keys'
import {
  assertPreviousStatementChangedOne,
  beginCatalogPublicationPlans,
  type CatalogPublication,
  CLEARED_MEDIA_RESULT as clearedResult,
  finishCatalogPublicationPlans,
  HOSTED_MEDIA_COLUMNS as hostedColumns,
  type StatementPlan
} from './plan-support'

/**
 * Statement plans for hosted listing media (serpcompany/best.serp.co#95). A listing image is
 * either hosted (a `listing_media` row with its key) or waiting in `media_ingestions`; nothing
 * ever stores a source URL as something to render. While a slot waits, the page shows the #86
 * fallback tile.
 *
 * Callers: request-time ingestion (submit v2 #84, admin edits #85) and the Worker cron that
 * retries pending slots. Approvals adopt a submission's hosted logo or queue it
 * (`adoptStagedLogoPlans` in plan-support).
 */

/** Minutes to wait after the 1st, 2nd, … failed attempt; after the last one a slot fails. */
export const MEDIA_RETRY_DELAYS_MINUTES = [15, 60, 240, 720, 1440, 2880] as const
/** The first attempt plus one retry per delay. */
export const MAX_MEDIA_ATTEMPTS = MEDIA_RETRY_DELAYS_MINUTES.length + 1
/** How long a claimed slot is reserved for the cron run that claimed it. */
export const MEDIA_CLAIM_LEASE_MINUTES = 10
/** Slots one cron run processes, which bounds its subrequests. */
export const MEDIA_INGESTION_BATCH_LIMIT = 10

export type MediaTarget = { listingId: string } | { submissionId: string }

export interface MediaSlot {
  kind: MediaKind
  sortOrder: number
  target: MediaTarget
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function requireInstant(now: string): number {
  const time = ISO_INSTANT.test(now) ? Date.parse(now) : Number.NaN
  if (Number.isNaN(time)) throw new Error('Plans need an ISO instant (toISOString()).')
  return time
}

function minutesAfter(now: string, minutes: number): string {
  return new Date(requireInstant(now) + minutes * 60 * 1000).toISOString()
}

/**
 * When to try a slot again after `attempts` failed attempts, or null once they are exhausted.
 */
export function nextMediaAttemptAt(now: string, attempts: number): string | null {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('A retry follows at least one failed attempt.')
  }
  const delay = MEDIA_RETRY_DELAYS_MINUTES[attempts - 1]
  return delay === undefined ? null : minutesAfter(now, delay)
}

function assertSlot(slot: MediaSlot): void {
  if (!(MEDIA_KINDS as readonly string[]).includes(slot.kind)) {
    throw new Error('Only logos and images are hosted.')
  }
  if (!Number.isSafeInteger(slot.sortOrder) || slot.sortOrder < 0) {
    throw new Error('A media slot needs a non-negative sort order.')
  }
  const id = 'listingId' in slot.target ? slot.target.listingId : slot.target.submissionId
  if (!id) throw new Error('A media slot needs its listing or submission.')
}

function assertHosted(media: HostedMedia, kind: MediaKind): void {
  if (!isMediaKey(media.key) || !media.key.includes(`/${kind}/`)) {
    throw new Error(`Media key ${media.key} is not a hosted ${kind} key.`)
  }
}

/** The target column, its value, and the partial unique index's conflict clause. */
function targetColumns(target: MediaTarget): { column: string; conflict: string; id: string } {
  return 'listingId' in target
    ? {
        column: 'listing_id',
        conflict: 'ON CONFLICT(listing_id,kind,sort_order) WHERE listing_id IS NOT NULL',
        id: target.listingId
      }
    : {
        column: 'submission_id',
        conflict: 'ON CONFLICT(submission_id,kind,sort_order) WHERE submission_id IS NOT NULL',
        id: target.submissionId
      }
}

function hostedValues(media: HostedMedia): unknown[] {
  return [media.key, media.sha256, media.contentType, media.bytes, media.width, media.height]
}

/**
 * Hosts a listing's logo or image slot: writes (or replaces) its `listing_media` row with the
 * key and metadata, clears the slot's queue entry, and advances the catalog version so cached
 * pages turn over. Used by admin edits (#85) and by the cron for queued listing slots.
 */
export function buildHostListingMediaPlans(input: {
  kind: MediaKind
  listingId: string
  media: HostedMedia
  publication: CatalogPublication
  sortOrder: number
}): StatementPlan[] {
  assertSlot({
    kind: input.kind,
    sortOrder: input.sortOrder,
    target: { listingId: input.listingId }
  })
  assertHosted(input.media, input.kind)
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: 'EXISTS (SELECT 1 FROM listings WHERE id=?)',
      params: [input.listingId]
    }),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order,${hostedColumns})
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(listing_id,kind,sort_order) DO UPDATE SET url=excluded.url,
          media_key=excluded.media_key,sha256=excluded.sha256,content_type=excluded.content_type,
          bytes=excluded.bytes,width=excluded.width,height=excluded.height`,
      params: [
        input.listingId,
        input.kind,
        input.media.sourceUrl,
        input.sortOrder,
        ...hostedValues(input.media)
      ]
    },
    assertPreviousStatementChangedOne('listing_media_hosted'),
    {
      sql: 'DELETE FROM media_ingestions WHERE listing_id=? AND kind=? AND sort_order=?',
      params: [input.listingId, input.kind, input.sortOrder]
    },
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * Records a submission's hosted logo or image (submit v2, #84, at submit time or from the cron).
 * Approval later copies it onto the listing when the submission still names the same source.
 */
export function buildRecordSubmissionMediaPlans(input: {
  kind: MediaKind
  media: HostedMedia
  now: string
  sortOrder: number
  submissionId: string
}): StatementPlan[] {
  const target = { submissionId: input.submissionId }
  assertSlot({ kind: input.kind, sortOrder: input.sortOrder, target })
  assertHosted(input.media, input.kind)
  requireInstant(input.now)
  const { conflict } = targetColumns(target)
  return [
    {
      sql: `INSERT INTO media_ingestions
        (submission_id,kind,sort_order,source_url,status,attempts,next_attempt_at,last_error,
         ${hostedColumns},created_at,updated_at)
        SELECT ?,?,?,?,'hosted',1,NULL,NULL,?,?,?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM listing_submissions WHERE id=?)
        ${conflict} DO UPDATE SET source_url=excluded.source_url,status='hosted',
          attempts=media_ingestions.attempts+1,next_attempt_at=NULL,last_error=NULL,
          media_key=excluded.media_key,sha256=excluded.sha256,
          content_type=excluded.content_type,bytes=excluded.bytes,width=excluded.width,
          height=excluded.height,updated_at=excluded.updated_at`,
      params: [
        input.submissionId,
        input.kind,
        input.sortOrder,
        input.media.sourceUrl,
        ...hostedValues(input.media),
        input.now,
        input.now,
        input.submissionId
      ]
    },
    assertPreviousStatementChangedOne('submission_media_hosted')
  ]
}

/**
 * Queues a slot for the cron without trying it first (attempts 0, due now), replacing whatever
 * the slot held before.
 */
export function buildQueueMediaPlans(
  input: MediaSlot & { now: string; sourceUrl: string }
): StatementPlan[] {
  assertSlot(input)
  requireInstant(input.now)
  const { column, conflict, id } = targetColumns(input.target)
  return [
    {
      sql: `INSERT INTO media_ingestions
        (${column},kind,sort_order,source_url,status,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,'pending',0,?,?,?)
        ${conflict} DO UPDATE SET source_url=excluded.source_url,status='pending',attempts=0,
          next_attempt_at=excluded.next_attempt_at,last_error=NULL,${clearedResult},
          updated_at=excluded.updated_at`,
      params: [id, input.kind, input.sortOrder, input.sourceUrl, input.now, input.now, input.now]
    },
    assertPreviousStatementChangedOne('media_queued')
  ]
}

/**
 * Records a failed attempt. A retryable failure stays `pending` until the backoff runs out
 * (`MEDIA_RETRY_DELAYS_MINUTES`); any other failure, or the last retry, marks the slot
 * `failed` with its reason, which the admin review screen shows (#85). `attempts` counts this
 * attempt.
 */
export function buildRecordMediaFailurePlans(
  input: MediaSlot & {
    attempts: number
    code: string
    now: string
    retryable: boolean
    sourceUrl: string
  }
): StatementPlan[] {
  assertSlot(input)
  if (!input.code.trim()) throw new Error('A media failure needs its reason.')
  const next = input.retryable ? nextMediaAttemptAt(input.now, input.attempts) : null
  const status = next ? 'pending' : 'failed'
  const { column, conflict, id } = targetColumns(input.target)
  return [
    {
      sql: `INSERT INTO media_ingestions
        (${column},kind,sort_order,source_url,status,attempts,next_attempt_at,last_error,
         created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ${conflict} DO UPDATE SET source_url=excluded.source_url,status=excluded.status,
          attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,
          last_error=excluded.last_error,${clearedResult},updated_at=excluded.updated_at`,
      params: [
        id,
        input.kind,
        input.sortOrder,
        input.sourceUrl,
        status,
        input.attempts,
        next,
        input.code.slice(0, 200),
        input.now,
        input.now
      ]
    },
    assertPreviousStatementChangedOne('media_failure_recorded')
  ]
}

/** Pending slots that are due, oldest first, with the slug their key is built from. */
export function selectDueMediaPlan(
  now: string,
  limit = MEDIA_INGESTION_BATCH_LIMIT
): StatementPlan {
  requireInstant(now)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('A media batch takes 1 to 50 slots.')
  }
  return {
    sql: `SELECT j.id,j.listing_id,j.submission_id,j.kind,j.sort_order,j.source_url,j.attempts,
        j.next_attempt_at,COALESCE(l.slug,s.slug) AS slug
      FROM media_ingestions j
      LEFT JOIN listings l ON l.id=j.listing_id
      LEFT JOIN listing_submissions s ON s.id=j.submission_id
      WHERE j.status='pending' AND j.next_attempt_at<=?
      ORDER BY j.next_attempt_at ASC, j.id ASC
      LIMIT ?`,
    params: [now, limit]
  }
}

/**
 * Claims a due slot for one cron run by moving its next attempt past the lease, compared and
 * swapped on the time the run read, so two runs never process the same slot.
 */
export function buildClaimMediaPlans(input: {
  id: number
  now: string
  readNextAttemptAt: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE media_ingestions SET next_attempt_at=?,updated_at=?
        WHERE id=? AND status='pending' AND next_attempt_at=?`,
      params: [
        minutesAfter(input.now, MEDIA_CLAIM_LEASE_MINUTES),
        input.now,
        input.id,
        input.readNextAttemptAt
      ]
    },
    assertPreviousStatementChangedOne('media_claimed')
  ]
}

/** A listing's slug and the publication state a hosting plan compares and swaps on. */
export function selectListingMediaContextPlan(listingId: string): StatementPlan {
  return {
    sql: `SELECT l.id,l.slug,ps.version,ps.checksum
      FROM listings l JOIN publication_state ps ON ps.id=1
      WHERE l.id=?`,
    params: [listingId]
  }
}

/** The media slots of a submission, for the admin review screen (#85). */
export function selectSubmissionMediaPlan(submissionId: string): StatementPlan {
  return {
    sql: `SELECT kind,sort_order,source_url,status,attempts,next_attempt_at,last_error,media_key
      FROM media_ingestions WHERE submission_id=? ORDER BY kind,sort_order`,
    params: [submissionId]
  }
}

/** A listing's media slots that are not hosted yet (queued or failed), for the admin (#85). */
export function selectListingMediaQueuePlan(listingId: string): StatementPlan {
  return {
    sql: `SELECT kind,sort_order,source_url,status,attempts,next_attempt_at,last_error
      FROM media_ingestions WHERE listing_id=? ORDER BY kind,sort_order`,
    params: [listingId]
  }
}
