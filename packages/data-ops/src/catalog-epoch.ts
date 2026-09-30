import { type SQL, sql } from 'drizzle-orm'
import { type Database, runQuery } from './client'
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
  try {
    const result = await runQuery<CatalogEpochRow>(input.client, catalogEpochStatement(input.asOf))
    const meta = result.meta as { duration?: number; rows_read?: number } | undefined
    rowsRead = typeof meta?.rows_read === 'number' ? meta.rows_read : null
    d1DurationMs = typeof meta?.duration === 'number' ? meta.duration : null
    resultRows = result.results.length
    success = result.success
    if (!result.success) throw new Error('D1 catalog epoch query failed.')
    return parseCatalogEpoch(result.results[0])
  } finally {
    input.observe?.({
      d1DurationMs,
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
