import {
  copyHostedMedia,
  fetchImage,
  hostedMediaFor,
  type IngestImageInput,
  ingestImage,
  type MediaBucket,
  type MediaFailure,
  scopedMediaBucket,
  storeHostedMedia
} from './media-ingest'
import {
  type HostedMedia,
  listingKeyForSubmissionKey,
  MEDIA_KINDS,
  type MediaKind,
  type MediaOwner,
  parseMediaKey
} from './media-keys'
import {
  buildClaimMediaPlans,
  buildForgetSubmissionMediaPlans,
  buildHostListingMediaPlans,
  buildQueueMediaPlans,
  buildRecordClaimedFailurePlans,
  buildRecordMediaFailurePlans,
  buildRecordSubmissionMediaPlans,
  MAX_MEDIA_ATTEMPTS,
  MEDIA_INGESTION_BATCH_LIMIT,
  type MediaClaim,
  type MediaTarget,
  mediaClaimLease,
  selectDueMediaPlan,
  selectFinishedSubmissionMediaPlan,
  selectListingMediaContextPlan,
  selectListingMediaQueuePlan,
  selectSubmissionMediaPlan
} from './media-plans'
import { prepareCatalogPublication, type StatementPlan } from './plan-support'

/**
 * Hosted listing media at runtime (serpcompany/best.serp.co#95): the entry points submit v2
 * (#84) and the admin listing editor (#85) call, and the Worker cron that retries queued slots.
 * Every fetch goes through `safeFetch`; every write is a statement plan sent as one D1 batch.
 */

export type MediaOutcome =
  | { key: string; status: 'hosted' }
  | { code: string; status: 'failed' | 'pending' }

export interface MediaSlotStatus {
  attempts: number
  kind: MediaKind
  lastError: string | null
  mediaKey: string | null
  nextAttemptAt: string | null
  sortOrder: number
  sourceUrl: string
  status: 'failed' | 'hosted' | 'pending'
}

export interface MediaRunSummary {
  failed: number
  hosted: number
  processed: number
  retried: number
  /** Slots an admin edit, approval, or publication changed while the run fetched them. */
  superseded: number
}

export interface MediaOperationsConfig {
  bucket: MediaBucket
  clock?: () => Date
  db: D1Database
  fetcher?: typeof fetch
  /** Structured log sink (no source URLs beyond their host, no bodies). */
  observe?: (event: Record<string, unknown>) => void
  /** Refuse ports other than 80 and 443 (default); a local Worker's fixture sites use others. */
  webPortsOnly?: boolean
}

export interface MediaOperations {
  /** An admin replaced a listing's logo or image (#85): host it now or queue it. */
  hostListingMedia(input: {
    actor: string
    kind: MediaKind
    listingId: string
    sortOrder: number
    sourceUrl: string
    workflow: string
  }): Promise<MediaOutcome>
  /** A submission named its logo or social image (#84): host it now or queue it. */
  hostSubmissionMedia(input: {
    kind: MediaKind
    sortOrder: number
    sourceUrl: string
    submissionId: string
  }): Promise<MediaOutcome>
  /** The cron: retry due slots, oldest first. */
  processDueMedia(limit?: number): Promise<MediaRunSummary>
  /** One listing's due slots now (after an admin approval queued its copies). */
  processListingMedia(listingId: string): Promise<MediaRunSummary>
  /** Deletes the images and slots of finished submissions (approved and copied, rejected, withdrawn). */
  forgetFinishedSubmissionMedia(limit?: number): Promise<number>
  /** Queued or failed slots of a listing, for the admin (#85). */
  listingMediaQueue(listingId: string): Promise<MediaSlotStatus[]>
  /** A submission's media slots and their state, for the review screen (#85). */
  submissionMedia(submissionId: string): Promise<MediaSlotStatus[]>
}

interface SlotRow {
  attempts: number
  kind: string
  last_error: string | null
  media_key?: string | null
  next_attempt_at: string | null
  sort_order: number
  source_url: string
  status: string
}

interface DueRow {
  attempts: number
  copy_from_key: string | null
  current_media: string | null
  id: number
  kind: string
  listing_id: string | null
  next_attempt_at: string
  slug: string | null
  sort_order: number
  source_url: string
  submission_id: string | null
}

/** A plan refused by its own compare-and-swap (`assertPreviousStatementChangedOne`). */
function isPlanConflict(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof Error && /malformed JSON/iu.test(current.message)) return true
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : null
  }
  return false
}

interface ListingContextRow {
  checksum: string
  slug: string
  version: number
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

function requireKind(value: string): MediaKind {
  if (!(MEDIA_KINDS as readonly string[]).includes(value)) throw new Error('Invalid media kind.')
  return value as MediaKind
}

function slotStatus(row: SlotRow): MediaSlotStatus {
  if (row.status !== 'pending' && row.status !== 'hosted' && row.status !== 'failed') {
    throw new Error('Invalid media slot status.')
  }
  return {
    attempts: row.attempts,
    kind: requireKind(row.kind),
    lastError: row.last_error,
    mediaKey: row.media_key ?? null,
    nextAttemptAt: row.next_attempt_at,
    sortOrder: row.sort_order,
    sourceUrl: row.source_url,
    status: row.status
  }
}

export function createMediaOperations(config: MediaOperationsConfig): MediaOperations {
  const { db } = config
  const now = () => (config.clock ?? (() => new Date()))().toISOString()
  const observe = config.observe ?? (() => {})

  async function run(plans: StatementPlan[]): Promise<void> {
    const results = await db.batch(plans.map(plan => db.prepare(plan.sql).bind(...plan.params)))
    if (results.some(result => !result.success)) throw new Error('D1 media batch failed.')
  }

  async function all<T>(plan: StatementPlan): Promise<T[]> {
    return (
      await db
        .prepare(plan.sql)
        .bind(...plan.params)
        .all<T>()
    ).results
  }

  async function listingContext(listingId: string): Promise<ListingContextRow> {
    const [row] = await all<ListingContextRow>(selectListingMediaContextPlan(listingId))
    if (!row) throw new Error('Listing not found.')
    return row
  }

  const bucket = scopedMediaBucket(config.bucket)

  async function ingest(input: { kind: MediaKind; sourceUrl: string } & MediaOwner) {
    const image: IngestImageInput = {
      ...input,
      bucket,
      fetcher: config.fetcher,
      webPortsOnly: config.webPortsOnly ?? true
    }
    return ingestImage(image)
  }

  async function hostOnListing(input: {
    actor: string
    claim?: MediaClaim
    kind: MediaKind
    listingId: string
    media: HostedMedia
    sortOrder: number
    workflow: string
  }): Promise<void> {
    const context = await listingContext(input.listingId)
    const publication = await prepareCatalogPublication({
      action: 'listing-media',
      actor: input.actor,
      affectedRoutes: `/products/${context.slug}/`,
      checksum: context.checksum,
      entityId: input.listingId,
      now: now(),
      version: context.version,
      workflow: input.workflow
    })
    await run(
      buildHostListingMediaPlans({
        claim: input.claim,
        kind: input.kind,
        listingId: input.listingId,
        media: input.media,
        publication,
        sortOrder: input.sortOrder
      })
    )
  }

  async function recordFailure(
    target: MediaTarget,
    slot: { kind: MediaKind; sortOrder: number; sourceUrl: string },
    failure: { code: string; retryable: boolean },
    attempts: number
  ): Promise<MediaOutcome> {
    const plans = buildRecordMediaFailurePlans({
      ...slot,
      attempts,
      code: failure.code,
      now: now(),
      retryable: failure.retryable,
      target
    })
    await run(plans)
    const pending = failure.retryable && attempts < MAX_MEDIA_ATTEMPTS
    return { code: failure.code, status: pending ? 'pending' : 'failed' }
  }

  /** Hosts one claimed slot: copy a submission's image, or fetch the source; never write it twice. */
  async function processClaimed(
    row: DueRow,
    claim: MediaClaim,
    summary: MediaRunSummary
  ): Promise<void> {
    const kind = requireKind(row.kind)
    const attempts = row.attempts + 1
    const fail = async (failure: { code: string; retryable: boolean }) => {
      await run(buildRecordClaimedFailurePlans({ ...failure, attempts, claim, now: now() }))
      if (failure.retryable && attempts < MAX_MEDIA_ATTEMPTS) summary.retried += 1
      else summary.failed += 1
    }
    try {
      if (row.listing_id) {
        if (!row.slug) return await fail({ code: 'target_missing', retryable: false })
        let result: { media: HostedMedia; ok: true } | MediaFailure | null = null
        const copied = row.copy_from_key ? parseMediaKey(row.copy_from_key) : null
        if (row.copy_from_key && !copied) {
          return await fail({ code: 'reviewed_copy_missing', retryable: false })
        }
        if (row.copy_from_key && copied) {
          // The submission's hosted copy, checked against its own digest.
          const [source] = await all<{
            bytes: number
            content_type: string
            height: number
            sha256: string
            width: number
          }>({
            sql: `SELECT bytes,content_type,height,sha256,width FROM media_ingestions
              WHERE media_key=? AND status='hosted' LIMIT 1`,
            params: [row.copy_from_key]
          })
          result = { code: 'reviewed_copy_missing', ok: false, retryable: false }
          if (source) {
            result = await copyHostedMedia(bucket, row.copy_from_key, {
              bytes: source.bytes,
              contentType: source.content_type,
              height: source.height,
              key: listingKeyForSubmissionKey(row.copy_from_key, row.slug),
              sha256: source.sha256,
              sourceUrl: row.source_url,
              width: source.width
            })
          }
          // A reviewed slot is only ever filled with the reviewed bytes (#96 review round 3,
          // B1): an R2 outage retries the copy; a gone or mismatched copy may be replaced only
          // by a refetch whose key, the content hash, is the reviewed one. Anything else leaves
          // the tile, with its reason for the admin, and is never published.
          if (!result.ok && !result.retryable) {
            const expected = listingKeyForSubmissionKey(row.copy_from_key, row.slug)
            const image = await fetchImage(row.source_url, {
              fetcher: config.fetcher,
              webPortsOnly: config.webPortsOnly ?? true
            })
            if (image.ok) {
              const media = hostedMediaFor(image, {
                kind,
                slug: row.slug,
                sourceUrl: row.source_url
              })
              result =
                media.key !== expected
                  ? { code: 'reviewed_copy_changed', ok: false, retryable: false }
                  : (await storeHostedMedia(bucket, media, image.body))
                    ? { media, ok: true }
                    : { code: 'store_failed', ok: false, retryable: true }
            } else if (!image.retryable) {
              result = { code: 'reviewed_copy_missing', ok: false, retryable: false }
            } else {
              result = image
            }
          }
        } else {
          result = await ingest({ kind, slug: row.slug, sourceUrl: row.source_url })
        }
        if (!result?.ok) {
          return await fail(result ?? { code: 'reviewed_copy_missing', retryable: false })
        }
        await hostOnListing({
          actor: 'media-cron',
          claim,
          kind,
          listingId: row.listing_id,
          media: result.media,
          sortOrder: row.sort_order,
          workflow: 'worker/media-cron'
        })
      } else {
        const submissionId = row.submission_id ?? ''
        const result = await ingest({ kind, sourceUrl: row.source_url, submissionId })
        if (!result.ok) return await fail(result)
        await run(
          buildRecordSubmissionMediaPlans({
            claim,
            kind,
            media: result.media,
            now: now(),
            sortOrder: row.sort_order,
            submissionId
          })
        )
      }
      summary.hosted += 1
    } catch (error) {
      if (isPlanConflict(error)) {
        // An admin edit, approval, or publication changed the slot: its result wins.
        summary.superseded += 1
        observe({ event: 'media_cron_superseded', id: row.id })
        return
      }
      // Anything else (D1 or R2 unavailable): the lease expires and the slot comes due again.
      observe({ event: 'media_cron_error', id: row.id })
    }
  }

  async function processDue(limit: number, listingId?: string): Promise<MediaRunSummary> {
    const summary: MediaRunSummary = {
      failed: 0,
      hosted: 0,
      processed: 0,
      retried: 0,
      superseded: 0
    }
    const due = await all<DueRow>(selectDueMediaPlan(now(), limit, listingId))
    for (const row of due) {
      const claimedAt = now()
      try {
        await run(
          buildClaimMediaPlans({
            id: row.id,
            now: claimedAt,
            readNextAttemptAt: row.next_attempt_at
          })
        )
      } catch {
        continue // Another run claimed it.
      }
      summary.processed += 1
      await processClaimed(
        row,
        {
          currentMedia: row.current_media,
          id: row.id,
          leaseUntil: mediaClaimLease(claimedAt),
          sourceUrl: row.source_url
        },
        summary
      )
    }
    observe({ event: 'media_cron', ...summary })
    return summary
  }

  return {
    async hostListingMedia(input) {
      const { slug } = await listingContext(input.listingId)
      const result = await ingest({ kind: input.kind, slug, sourceUrl: input.sourceUrl })
      observe({
        event: 'media_ingest',
        host: hostOf(input.sourceUrl),
        outcome: result.ok ? 'hosted' : result.code,
        target: 'listing'
      })
      if (!result.ok) {
        return recordFailure({ listingId: input.listingId }, input, result, 1)
      }
      await hostOnListing({ ...input, media: result.media })
      return { key: result.media.key, status: 'hosted' }
    },

    async hostSubmissionMedia(input) {
      const [submission] = await all<{ id: string }>({
        sql: 'SELECT id FROM listing_submissions WHERE id=?',
        params: [input.submissionId]
      })
      if (!submission) throw new Error('Submission not found.')
      // Under the submission's own prefix, never a live listing's path (#95 review S1).
      const result = await ingest({
        kind: input.kind,
        sourceUrl: input.sourceUrl,
        submissionId: input.submissionId
      })
      observe({
        event: 'media_ingest',
        host: hostOf(input.sourceUrl),
        outcome: result.ok ? 'hosted' : result.code,
        target: 'submission'
      })
      if (!result.ok) {
        return recordFailure({ submissionId: input.submissionId }, input, result, 1)
      }
      await run(
        buildRecordSubmissionMediaPlans({
          kind: input.kind,
          media: result.media,
          now: now(),
          sortOrder: input.sortOrder,
          submissionId: input.submissionId
        })
      )
      return { key: result.media.key, status: 'hosted' }
    },

    processDueMedia(limit = MEDIA_INGESTION_BATCH_LIMIT) {
      return processDue(limit)
    },

    processListingMedia(listingId) {
      return processDue(MEDIA_INGESTION_BATCH_LIMIT, listingId)
    },

    async forgetFinishedSubmissionMedia(limit = MEDIA_INGESTION_BATCH_LIMIT) {
      let forgotten = 0
      const rows = await all<{ id: number; media_key: string | null }>(
        selectFinishedSubmissionMediaPlan(limit)
      )
      for (const row of rows) {
        try {
          // The object first: a row is only forgotten once nothing is left behind in R2.
          if (row.media_key) await bucket.delete?.(row.media_key)
          await run(buildForgetSubmissionMediaPlans({ id: row.id, mediaKey: row.media_key }))
          forgotten += 1
        } catch {
          observe({ event: 'media_forget_error', id: row.id })
        }
      }
      if (rows.length) observe({ event: 'media_forget', forgotten })
      return forgotten
    },

    async listingMediaQueue(listingId) {
      return (await all<SlotRow>(selectListingMediaQueuePlan(listingId))).map(slotStatus)
    },

    async submissionMedia(submissionId) {
      return (await all<SlotRow>(selectSubmissionMediaPlan(submissionId))).map(slotStatus)
    }
  }
}

/** Queues a slot without trying it now (for example when a request has no time to fetch). */
export async function queueMedia(
  db: D1Database,
  input: Parameters<typeof buildQueueMediaPlans>[0]
): Promise<void> {
  const plans = buildQueueMediaPlans(input)
  const results = await db.batch(plans.map(plan => db.prepare(plan.sql).bind(...plan.params)))
  if (results.some(result => !result.success)) throw new Error('D1 media batch failed.')
}
