import {
  type HostedMedia,
  isPendingMediaKey,
  MEDIA_KINDS,
  type MediaKind,
  parseMediaKey
} from './media-keys'
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
 * retries pending slots. Approvals queue a submission's hosted images for a copy into the
 * listing's path (`adoptStagedLogoPlans`, `adoptSubmissionImagePlans` in plan-support).
 *
 * The cron writes only while its claim holds: the claimed row (id, lease, source) must still be
 * there, and the listing's slot must still hold what it held when the slot was read. An admin
 * edit, an approval, or a publication that changes the slot meanwhile wins; the cron's result is
 * dropped as superseded and never retried.
 */

/** Minutes to wait after the 1st, 2nd, … failed attempt; after the last one a slot fails. */
export const MEDIA_RETRY_DELAYS_MINUTES = [15, 60, 240, 720, 1440, 2880] as const
/** The first attempt plus one retry per delay. */
export const MAX_MEDIA_ATTEMPTS = MEDIA_RETRY_DELAYS_MINUTES.length + 1
/** How long a claimed slot is reserved for the cron run that claimed it. */
export const MEDIA_CLAIM_LEASE_MINUTES = 10
/** Slots one cron run processes, which bounds its subrequests. */
export const MEDIA_INGESTION_BATCH_LIMIT = 10

export type MediaTarget = { listingId: string } | { submissionId: string } | { revisionId: string }

/** A submission or a revision whose images wait for its review (#96 round 4). */
export type PendingMediaOwner = { submissionId: string } | { revisionId: string }

function targetId(target: MediaTarget): string {
  return 'listingId' in target
    ? target.listingId
    : 'submissionId' in target
      ? target.submissionId
      : target.revisionId
}

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
  if (!targetId(slot.target))
    throw new Error('A media slot needs its listing, submission or revision.')
}

function assertHosted(
  media: HostedMedia,
  kind: MediaKind,
  scope: 'listings' | 'revisions' | 'submissions'
): void {
  const parsed = parseMediaKey(media.key)
  if (parsed?.scope !== scope || parsed.kind !== kind) {
    throw new Error(`Media key ${media.key} is not a hosted ${kind} key for ${scope}.`)
  }
}

/** The target column, its value, and the partial unique index's conflict clause. */
function targetColumns(target: MediaTarget): { column: string; conflict: string; id: string } {
  const column =
    'listingId' in target
      ? 'listing_id'
      : 'submissionId' in target
        ? 'submission_id'
        : 'revision_id'
  return {
    column,
    conflict: `ON CONFLICT(${column},kind,sort_order) WHERE ${column} IS NOT NULL`,
    id: targetId(target)
  }
}

function hostedValues(media: HostedMedia): unknown[] {
  return [media.key, media.sha256, media.contentType, media.bytes, media.width, media.height]
}

/**
 * A due slot one cron run claimed: its row, the lease it set, the source it read, and what the
 * listing's slot held when it was read (`COALESCE(media_key,url)`, null for an empty slot).
 */
export interface MediaClaim {
  currentMedia: string | null
  id: number
  leaseUntil: string
  sourceUrl: string
}

/** The lease a claim sets: the slot comes due again if the run never finishes. */
export function mediaClaimLease(now: string): string {
  return minutesAfter(now, MEDIA_CLAIM_LEASE_MINUTES)
}

const claimHolds = `EXISTS (SELECT 1 FROM media_ingestions WHERE id=? AND status='pending'
  AND next_attempt_at=? AND source_url=?)`

/**
 * Hosts a listing's logo or image slot: writes (or replaces) its `listing_media` row with the
 * key and metadata, clears the slot's queue entry, and advances the catalog version so cached
 * pages turn over. With a `claim` (the cron), it applies only while the claim holds and the slot
 * still holds what it held when read; otherwise the batch is refused as superseded.
 */
export function buildHostListingMediaPlans(input: {
  claim?: MediaClaim
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
  assertHosted(input.media, input.kind, 'listings')
  const { claim } = input
  const slotValue = `(SELECT COALESCE(media_key,url) FROM listing_media
    WHERE listing_id=? AND kind=? AND sort_order=?)`
  return [
    ...beginCatalogPublicationPlans(
      input.publication,
      claim
        ? {
            sql: `EXISTS (SELECT 1 FROM listings WHERE id=?) AND ${claimHolds}
              AND ${slotValue} IS ?`,
            params: [
              input.listingId,
              claim.id,
              claim.leaseUntil,
              claim.sourceUrl,
              input.listingId,
              input.kind,
              input.sortOrder,
              claim.currentMedia
            ]
          }
        : { sql: 'EXISTS (SELECT 1 FROM listings WHERE id=?)', params: [input.listingId] },
      claim ? 'media_claim_current' : 'publication_snapshot_current'
    ),
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
 * Records a submission's hosted logo or image (`best.serp.co/submissions/<id>/…`): at submit time
 * (submit v2, #84) as an upsert, or from the cron while its claim holds. Approval later queues a
 * copy into the listing's path.
 */
export function buildRecordSubmissionMediaPlans(input: {
  claim?: MediaClaim
  kind: MediaKind
  media: HostedMedia
  now: string
  sortOrder: number
  submissionId: string
}): StatementPlan[] {
  const { submissionId, ...rest } = input
  return buildRecordPendingMediaPlans({ ...rest, owner: { submissionId } })
}

/**
 * Records a submission's or a revision's hosted image under its own pending prefix
 * (`submissions/<id>/…`, `revisions/<id>/…`, #96 round 4): when it is saved, as an upsert, or
 * from the cron while its claim holds. The review screen shows it; approval adopts that key.
 */
export function buildRecordPendingMediaPlans(input: {
  claim?: MediaClaim
  kind: MediaKind
  media: HostedMedia
  now: string
  owner: PendingMediaOwner
  sortOrder: number
}): StatementPlan[] {
  const target: MediaTarget = input.owner
  const revision = 'revisionId' in target
  assertSlot({ kind: input.kind, sortOrder: input.sortOrder, target })
  assertHosted(input.media, input.kind, revision ? 'revisions' : 'submissions')
  requireInstant(input.now)
  if (input.claim) {
    return [
      {
        sql: `UPDATE media_ingestions SET status='hosted',attempts=attempts+1,next_attempt_at=NULL,
            last_error=NULL,media_key=?,sha256=?,content_type=?,bytes=?,width=?,height=?,
            updated_at=?
          WHERE id=? AND status='pending' AND next_attempt_at=? AND source_url=?`,
        params: [
          ...hostedValues(input.media),
          input.now,
          input.claim.id,
          input.claim.leaseUntil,
          input.claim.sourceUrl
        ]
      },
      assertPreviousStatementChangedOne('media_claim_current')
    ]
  }
  const { column, conflict, id } = targetColumns(target)
  return [
    {
      sql: `INSERT INTO media_ingestions
        (${column},kind,sort_order,source_url,status,attempts,next_attempt_at,last_error,
         ${hostedColumns},created_at,updated_at)
        SELECT ?,?,?,?,'hosted',1,NULL,NULL,?,?,?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM ${revision ? 'listing_revisions' : 'listing_submissions'}
          WHERE id=?)
        ${conflict} DO UPDATE SET source_url=excluded.source_url,status='hosted',
          attempts=media_ingestions.attempts+1,next_attempt_at=NULL,last_error=NULL,
          copy_from_key=NULL,media_key=excluded.media_key,sha256=excluded.sha256,
          content_type=excluded.content_type,bytes=excluded.bytes,width=excluded.width,
          height=excluded.height,updated_at=excluded.updated_at`,
      params: [
        id,
        input.kind,
        input.sortOrder,
        input.media.sourceUrl,
        ...hostedValues(input.media),
        input.now,
        input.now,
        id
      ]
    },
    assertPreviousStatementChangedOne(
      revision ? 'revision_media_hosted' : 'submission_media_hosted'
    )
  ]
}

/**
 * Queues a slot for the cron without trying it first (attempts 0, due now), replacing whatever
 * the slot held before. `copyFromKey` names a submission's or a revision's hosted copy to use
 * instead of the source (approval).
 */
export function buildQueueMediaPlans(
  input: MediaSlot & { copyFromKey?: string; now: string; sourceUrl: string }
): StatementPlan[] {
  assertSlot(input)
  requireInstant(input.now)
  if (input.copyFromKey && !isPendingMediaKey(input.copyFromKey)) {
    throw new Error('Only a submission or revision key is copied into a listing.')
  }
  const { column, conflict, id } = targetColumns(input.target)
  return [
    {
      sql: `INSERT INTO media_ingestions
        (${column},kind,sort_order,source_url,copy_from_key,status,attempts,next_attempt_at,
         created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',0,?,?,?)
        ${conflict} DO UPDATE SET source_url=excluded.source_url,
          copy_from_key=excluded.copy_from_key,status='pending',attempts=0,
          next_attempt_at=excluded.next_attempt_at,last_error=NULL,${clearedResult},
          updated_at=excluded.updated_at`,
      params: [
        id,
        input.kind,
        input.sortOrder,
        input.sourceUrl,
        input.copyFromKey ?? null,
        input.now,
        input.now,
        input.now
      ]
    },
    assertPreviousStatementChangedOne('media_queued')
  ]
}

function failureState(input: { attempts: number; now: string; retryable: boolean }) {
  const next = input.retryable ? nextMediaAttemptAt(input.now, input.attempts) : null
  return { next, status: next ? 'pending' : 'failed' }
}

/**
 * Records a failed request-time attempt (attempts 1). A retryable failure stays `pending` until
 * the backoff runs out (`MEDIA_RETRY_DELAYS_MINUTES`); any other failure, or the last retry,
 * marks the slot `failed` with its reason, which the admin sees.
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
  const { next, status } = failureState(input)
  const { column, conflict, id } = targetColumns(input.target)
  return [
    {
      sql: `INSERT INTO media_ingestions
        (${column},kind,sort_order,source_url,status,attempts,next_attempt_at,last_error,
         created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ${conflict} DO UPDATE SET source_url=excluded.source_url,copy_from_key=NULL,
          status=excluded.status,attempts=excluded.attempts,
          next_attempt_at=excluded.next_attempt_at,last_error=excluded.last_error,
          ${clearedResult},updated_at=excluded.updated_at`,
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

/** Records a failed cron attempt on the claimed row only; a lost claim is superseded. */
export function buildRecordClaimedFailurePlans(input: {
  attempts: number
  claim: MediaClaim
  code: string
  now: string
  retryable: boolean
}): StatementPlan[] {
  if (!input.code.trim()) throw new Error('A media failure needs its reason.')
  const { next, status } = failureState(input)
  return [
    {
      sql: `UPDATE media_ingestions SET status=?,attempts=?,next_attempt_at=?,last_error=?,
          updated_at=?
        WHERE id=? AND status='pending' AND next_attempt_at=? AND source_url=?`,
      params: [
        status,
        input.attempts,
        next,
        input.code.slice(0, 200),
        input.now,
        input.claim.id,
        input.claim.leaseUntil,
        input.claim.sourceUrl
      ]
    },
    assertPreviousStatementChangedOne('media_claim_current')
  ]
}

/**
 * Pending slots that are due (one listing's, or all), oldest first, with the slug, submission
 * id or revision id their key is built from, the submission copy to use, and what the listing's slot holds now.
 */
export function selectDueMediaPlan(
  now: string,
  limit = MEDIA_INGESTION_BATCH_LIMIT,
  listingId?: string
): StatementPlan {
  requireInstant(now)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('A media batch takes 1 to 50 slots.')
  }
  return {
    sql: `SELECT j.id,j.listing_id,j.submission_id,j.revision_id,j.kind,j.sort_order,j.source_url,
        j.copy_from_key,j.attempts,j.next_attempt_at,l.slug,
        (SELECT COALESCE(m.media_key,m.url) FROM listing_media m WHERE m.listing_id=j.listing_id
          AND m.kind=j.kind AND m.sort_order=j.sort_order) AS current_media
      FROM media_ingestions j
      LEFT JOIN listings l ON l.id=j.listing_id
      WHERE j.status='pending' AND j.next_attempt_at<=?${listingId ? ' AND j.listing_id=?' : ''}
      ORDER BY j.next_attempt_at ASC, j.id ASC
      LIMIT ?`,
    params: listingId ? [now, listingId, limit] : [now, limit]
  }
}

/**
 * Claims a due slot for one cron run by moving its next attempt to the lease, compared and
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
      params: [mediaClaimLease(input.now), input.now, input.id, input.readNextAttemptAt]
    },
    assertPreviousStatementChangedOne('media_claimed')
  ]
}

/**
 * Pending media slots whose submission or revision is finished (#96 review S1, round 4):
 * rejected or withdrawn (which covers an expired draft), or approved with no listing slot still
 * waiting to copy its image. Their images under `best.serp.co/submissions/<id>/` or
 * `best.serp.co/revisions/<id>/` are deleted, then the rows; the cron stops retrying slots
 * nobody will review. An R2 lifecycle rule on those prefixes (an owner action, docs/MEDIA.md)
 * catches anything this misses.
 */
export function selectFinishedPendingMediaPlan(limit = MEDIA_INGESTION_BATCH_LIMIT): StatementPlan {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('A media batch takes 1 to 50 slots.')
  }
  return {
    sql: `SELECT j.id,j.media_key FROM media_ingestions j
      LEFT JOIN listing_submissions s ON s.id=j.submission_id
      LEFT JOIN listing_revisions r ON r.id=j.revision_id
      WHERE (s.status IN ('approved','rejected','withdrawn')
          OR r.status IN ('approved','rejected','withdrawn'))
        AND (j.media_key IS NULL OR NOT EXISTS (SELECT 1 FROM media_ingestions q
          WHERE q.copy_from_key=j.media_key AND q.status='pending'))
      ORDER BY j.id ASC
      LIMIT ?`,
    params: [limit]
  }
}

/** Removes a finished submission's or revision's slot once its image (if any) is deleted. */
export function buildForgetPendingMediaPlans(input: {
  id: number
  mediaKey: string | null
}): StatementPlan[] {
  if (input.mediaKey !== null && !isPendingMediaKey(input.mediaKey)) {
    throw new Error('Only a submission’s or revision’s own media is forgotten.')
  }
  return [
    {
      sql: `DELETE FROM media_ingestions WHERE id=?
        AND (submission_id IS NOT NULL OR revision_id IS NOT NULL) AND media_key IS ?`,
      params: [input.id, input.mediaKey]
    }
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
