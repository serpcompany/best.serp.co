import {
  type IngestImageInput,
  ingestImage,
  type MediaBucket,
  scopedMediaBucket
} from './media-ingest'
import { MEDIA_KINDS, type MediaKind } from './media-keys'
import {
  buildClaimMediaPlans,
  buildHostListingMediaPlans,
  buildQueueMediaPlans,
  buildRecordMediaFailurePlans,
  buildRecordSubmissionMediaPlans,
  MAX_MEDIA_ATTEMPTS,
  MEDIA_INGESTION_BATCH_LIMIT,
  type MediaTarget,
  selectDueMediaPlan,
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
}

export interface MediaOperationsConfig {
  bucket: MediaBucket
  clock?: () => Date
  db: D1Database
  fetcher?: typeof fetch
  /** Structured log sink (no source URLs beyond their host, no bodies). */
  observe?: (event: Record<string, unknown>) => void
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
  id: number
  kind: string
  listing_id: string | null
  next_attempt_at: string
  slug: string | null
  sort_order: number
  source_url: string
  submission_id: string | null
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

  async function ingest(input: Omit<IngestImageInput, 'bucket' | 'fetcher'>) {
    return ingestImage({ ...input, bucket, fetcher: config.fetcher })
  }

  async function hostOnListing(input: {
    actor: string
    kind: MediaKind
    listingId: string
    media: Parameters<typeof buildHostListingMediaPlans>[0]['media']
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
      const [submission] = await all<{ slug: string }>({
        sql: 'SELECT slug FROM listing_submissions WHERE id=?',
        params: [input.submissionId]
      })
      if (!submission) throw new Error('Submission not found.')
      const result = await ingest({
        kind: input.kind,
        slug: submission.slug,
        sourceUrl: input.sourceUrl
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

    async processDueMedia(limit = MEDIA_INGESTION_BATCH_LIMIT) {
      const summary: MediaRunSummary = { failed: 0, hosted: 0, processed: 0, retried: 0 }
      const due = await all<DueRow>(selectDueMediaPlan(now(), limit))
      for (const row of due) {
        try {
          await run(
            buildClaimMediaPlans({ id: row.id, now: now(), readNextAttemptAt: row.next_attempt_at })
          )
        } catch {
          continue // Another run claimed it.
        }
        summary.processed += 1
        const kind = requireKind(row.kind)
        const target: MediaTarget = row.listing_id
          ? { listingId: row.listing_id }
          : { submissionId: row.submission_id ?? '' }
        const slot = { kind, sortOrder: row.sort_order, sourceUrl: row.source_url }
        const attempts = row.attempts + 1
        try {
          const result = row.slug
            ? await ingest({ kind, slug: row.slug, sourceUrl: row.source_url })
            : ({ code: 'target_missing', ok: false, retryable: false } as const)
          if (!result.ok) {
            const outcome = await recordFailure(target, slot, result, attempts)
            if (outcome.status === 'failed') summary.failed += 1
            else summary.retried += 1
            continue
          }
          if ('listingId' in target) {
            await hostOnListing({
              actor: 'media-cron',
              kind,
              listingId: target.listingId,
              media: result.media,
              sortOrder: row.sort_order,
              workflow: 'worker/media-cron'
            })
          } else {
            await run(
              buildRecordSubmissionMediaPlans({
                kind,
                media: result.media,
                now: now(),
                sortOrder: row.sort_order,
                submissionId: target.submissionId
              })
            )
          }
          summary.hosted += 1
        } catch {
          // A failed write (for example a concurrent publication) is retried on the next run;
          // if even that cannot be recorded, the lease expires and the slot comes due again.
          try {
            await recordFailure(target, slot, { code: 'write_failed', retryable: true }, attempts)
          } catch {
            observe({ event: 'media_cron_record_failed', id: row.id })
          }
          summary.retried += 1
        }
      }
      observe({ event: 'media_cron', ...summary })
      return summary
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
