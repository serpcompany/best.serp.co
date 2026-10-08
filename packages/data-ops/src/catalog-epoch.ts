import { type SQL, sql } from 'drizzle-orm'
import { type Database, d1ErrorCode, runQuery } from './client'
import type { CatalogObserver } from './contracts'

/**
 * The public catalog changes only when `publication_state.version` changes (a publication
 * or approval) or when a listing scheduled with a future `published_at` becomes due. The
 * epoch captures both, so every cache keyed by it (the data cache and the edge HTML cache)
 * turns over exactly when public content can change, with no time-based expiry needed.
 *
 * This module deliberately has no `server-only` import: the Worker entry (`apps/web/worker.ts`)
 * reads the epoch before the Next.js server is loaded.
 */
export interface CatalogEpoch {
  /** Latest `published_at` that is already public, or null for an empty catalog. */
  effectiveAt: string | null
  version: number
}

interface CatalogEpochRow {
  effective_at: string | null
  version: number
}

export function catalogEpochStatement(asOf: string): SQL<CatalogEpochRow> {
  return sql<CatalogEpochRow>`SELECT
    ps.version AS version,
    (
      SELECT MAX(l.published_at)
      FROM listings l
      WHERE l.status = 'approved' AND l.is_active = 1 AND l.published_at IS NOT NULL
        AND l.published_at <= ${asOf}
    ) AS effective_at
  FROM publication_state ps
  WHERE ps.id = 1
  LIMIT 1`
}

export function parseCatalogEpoch(row: CatalogEpochRow | undefined): CatalogEpoch {
  const version = row?.version
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new Error('Invalid D1 publication state.')
  }
  const effectiveAt = row?.effective_at
  if (effectiveAt !== null && effectiveAt !== undefined && typeof effectiveAt !== 'string') {
    throw new Error('Invalid D1 publication time.')
  }
  return { effectiveAt: effectiveAt || null, version: version as number }
}

/** Stable, cache-key-safe identity of a catalog epoch. */
export function catalogEpochToken(epoch: CatalogEpoch): string {
  return `${epoch.version}.${epoch.effectiveAt ?? 'none'}`
}

/** The epoch a `catalogEpochToken` names, or null for anything else. */
export function parseCatalogEpochToken(token: string): CatalogEpoch | null {
  const separator = token.indexOf('.')
  if (separator < 1) return null
  const version = Number(token.slice(0, separator))
  const effectiveAt = token.slice(separator + 1)
  if (!/^\d+$/u.test(token.slice(0, separator)) || !Number.isSafeInteger(version)) return null
  if (!effectiveAt) return null
  return { effectiveAt: effectiveAt === 'none' ? null : effectiveAt, version }
}

/**
 * How long a render may reuse the epoch the Worker entry read. It matches the entry's own
 * freshness (`EPOCH_FRESH_MS` in `apps/web/lib/edge-cache/html-cache.ts`), so a render never
 * keys the data cache with an older epoch than the edge cache it is rendered for.
 */
export const SHARED_EPOCH_MAX_AGE_MS = 30_000

/**
 * The Worker entry and the Next.js server are separate bundles in one isolate, so the
 * epoch is shared through a global, never through anything a request carries.
 */
const SHARED_EPOCH = Symbol.for('serpdirectory.catalog-epoch')

interface SharedEpoch {
  epoch: CatalogEpoch
  sharedAt: number
}

/** Records the epoch token the Worker entry just obtained, for this isolate's renders. */
export function shareCatalogEpochToken(token: string, now = Date.now()): void {
  const epoch = parseCatalogEpochToken(token)
  if (!epoch) return
  ;(globalThis as Record<symbol, unknown>)[SHARED_EPOCH] = { epoch, sharedAt: now }
}

/** The epoch the Worker entry shared within `maxAgeMs`, or null. */
export function sharedCatalogEpoch(
  now = Date.now(),
  maxAgeMs = SHARED_EPOCH_MAX_AGE_MS
): CatalogEpoch | null {
  const shared = (globalThis as Record<symbol, unknown>)[SHARED_EPOCH] as SharedEpoch | undefined
  if (!shared) return null
  const age = now - shared.sharedAt
  return age >= 0 && age < maxAgeMs ? { ...shared.epoch } : null
}

/**
 * Whether `slug` names a listing that was published and is now unpublished (`status =
 * 'approved'`, `is_active = 0`), whose URL answers 410 Gone (#64). One seek on the unique slug.
 * The Worker entry asks only after a listing page rendered 404, before Next.js knows the status.
 */
export async function isUnpublishedListingSlug(input: {
  client: Database
  observe?: CatalogObserver
  slug: string
}): Promise<boolean> {
  const startedAt = performance.now()
  let success = false
  let resultRows = 0
  try {
    const result = await runQuery<{ found: number }>(
      input.client,
      sql<{ found: number }>`SELECT 1 AS found FROM listings
        WHERE slug = ${input.slug} AND status = 'approved' AND is_active = 0
          AND published_at IS NOT NULL
        LIMIT 1`
    )
    success = result.success
    resultRows = result.results.length
    return result.results.length === 1
  } finally {
    input.observe?.({
      d1DurationMs: null,
      event: 'd1_query',
      operation: 'unpublished-listing-status',
      queryShape: 'unpublished-listing-status',
      resultRows,
      rowsRead: null,
      rowsWritten: 0,
      success,
      wallDurationMs: performance.now() - startedAt
    })
  }
}

/**
 * Where an old root-level URL `/<slug>` moved (#168): a public listing first, then an active
 * category, or null. One seek on each unique slug, so the Worker entry can answer the one 308
 * itself instead of letting Next.js redirect after the trailing-slash rule (two hops).
 */
export async function legacyRootTarget(input: {
  asOf: string
  client: Database
  observe?: CatalogObserver
  slug: string
}): Promise<'category' | 'listing' | null> {
  const startedAt = performance.now()
  let rowsRead: number | null = null
  let d1DurationMs: number | null = null
  let success = false
  let resultRows = 0
  let errorCode: string | undefined
  try {
    const result = await runQuery<{ kind: 'category' | 'listing' }>(
      input.client,
      sql<{ kind: 'category' | 'listing' }>`SELECT kind FROM (
          SELECT 'listing' AS kind, 0 AS rank FROM listings
            WHERE slug = ${input.slug} AND status = 'approved' AND is_active = 1
              AND published_at IS NOT NULL AND published_at <= ${input.asOf}
          UNION ALL
          SELECT 'category' AS kind, 1 AS rank FROM categories
            WHERE slug = ${input.slug} AND is_active = 1
        )
        ORDER BY rank
        LIMIT 1`
    )
    const meta = result.meta as { duration?: number; rows_read?: number } | undefined
    rowsRead = typeof meta?.rows_read === 'number' ? meta.rows_read : null
    d1DurationMs = typeof meta?.duration === 'number' ? meta.duration : null
    success = result.success
    resultRows = result.results.length
    if (!result.success) throw new Error('D1 legacy root-level URL query failed.')
    return result.results[0]?.kind ?? null
  } catch (error) {
    errorCode = d1ErrorCode(error)
    throw error
  } finally {
    input.observe?.({
      d1DurationMs,
      ...(errorCode ? { errorCode } : {}),
      event: 'd1_query',
      operation: 'legacy-root-target',
      queryShape: 'legacy-root-target',
      resultRows,
      rowsRead,
      rowsWritten: 0,
      success,
      wallDurationMs: performance.now() - startedAt
    })
  }
}

/**
 * Reads the epoch with one prepared statement (two index seeks) and reports the same
 * `d1_query` telemetry the catalog operations emit.
 */
export async function readCatalogEpoch(input: {
  asOf: string
  client: Database
  observe?: CatalogObserver
}): Promise<CatalogEpoch> {
  const startedAt = performance.now()
  let rowsRead: number | null = null
  let d1DurationMs: number | null = null
  let resultRows = 0
  let success = false
  let errorCode: string | undefined
  try {
    const result = await runQuery<CatalogEpochRow>(input.client, catalogEpochStatement(input.asOf))
    const meta = result.meta as { duration?: number; rows_read?: number } | undefined
    rowsRead = typeof meta?.rows_read === 'number' ? meta.rows_read : null
    d1DurationMs = typeof meta?.duration === 'number' ? meta.duration : null
    resultRows = result.results.length
    success = result.success
    if (!result.success) throw new Error('D1 catalog epoch query failed.')
    return parseCatalogEpoch(result.results[0])
  } catch (error) {
    errorCode = d1ErrorCode(error)
    throw error
  } finally {
    input.observe?.({
      d1DurationMs,
      ...(errorCode ? { errorCode } : {}),
      event: 'd1_query',
      operation: 'publication-version',
      queryShape: 'publication-version',
      resultRows,
      rowsRead,
      rowsWritten: 0,
      success,
      wallDurationMs: performance.now() - startedAt
    })
  }
}
