import { type SQL, sql } from 'drizzle-orm'
import { type Database, d1ErrorCode, runQuery } from './client'
import type { CatalogObserver, TaxonomyTarget } from './contracts'
import { listingInRetiredCategory } from './plan-support'

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
 * freshness (`EPOCH_FRESH_MS` in `apps/web/src/lib/edge-cache/html-cache.ts`), so a render never
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
 * Listing `l` is filed under a retired category (`listingInRetiredCategory`, #260, the Adult
 * category): an unpublished listing filed under one answers a plain 404, never the 410 gone page,
 * which would point visitors back to the catalog and offer to relist it.
 */
export const LISTING_IN_RETIRED_CATEGORY_SQL = listingInRetiredCategory('l.id')

/**
 * Whether `slug` names a listing that was published and is now unpublished (`status =
 * 'approved'`, `is_active = 0`), whose URL answers 410 Gone (#64), unless it is filed under a
 * retired category (`LISTING_IN_RETIRED_CATEGORY_SQL`), which leaves its 404 standing. One seek
 * on the unique slug. The Worker entry asks only after a listing page rendered 404, before
 * Next.js knows the status.
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
      sql<{ found: number }>`SELECT 1 AS found FROM listings l
        WHERE l.slug = ${input.slug} AND l.status = 'approved' AND l.is_active = 0
          AND l.published_at IS NOT NULL
          AND NOT ${sql.raw(LISTING_IN_RETIRED_CATEGORY_SQL)}
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
 * The current slug of a `taxonomy_redirects` row `r`'s target (#341, design 2.2), or NULL when
 * the target is not public: retired, or a best page whose tag or category is retired (the best
 * index leaves that page out, so it answers 404). Its target is a foreign key, so a rename keeps
 * the redirect current. Each join is a primary-key seek, and only the row's own target kind
 * matches one.
 */
export const TAXONOMY_TARGET_JOINS = `LEFT JOIN categories target_c
    ON target_c.id = r.target_category_id AND target_c.is_active = 1
  LEFT JOIN tags target_t ON target_t.id = r.target_tag_id AND target_t.is_active = 1
  LEFT JOIN best_pages target_b ON target_b.id = r.target_best_page_id AND target_b.is_active = 1
    AND (target_b.tag_id IS NULL OR EXISTS (
      SELECT 1 FROM tags target_bt WHERE target_bt.id = target_b.tag_id AND target_bt.is_active = 1
    ))
    AND (target_b.category_id IS NULL OR EXISTS (
      SELECT 1 FROM categories target_bc
      WHERE target_bc.id = target_b.category_id AND target_bc.is_active = 1
    ))`
export const TAXONOMY_TARGET_SLUG = 'COALESCE(target_c.slug, target_t.slug, target_b.slug)'

/** A `taxonomy_redirects` target read with `TAXONOMY_TARGET_SLUG`, or null when it is retired. */
export function parseTaxonomyTarget(kind: unknown, slug: unknown): TaxonomyTarget | null {
  if (kind === 'directory') return { kind, slug: null }
  if (kind !== 'best' && kind !== 'category' && kind !== 'tag') {
    throw new Error('Invalid D1 taxonomy redirect kind.')
  }
  if (slug === null || slug === undefined) return null
  if (typeof slug !== 'string' || !slug) throw new Error('Invalid D1 taxonomy redirect target.')
  return { kind, slug }
}

/** `alias` is a public listing as of `asOf`: the catalog's public eligibility. */
function publicListing(alias: string, asOf: string): SQL {
  const l = sql.raw(alias)
  return sql`${l}.status = 'approved' AND ${l}.is_active = 1 AND ${l}.published_at IS NOT NULL
    AND ${l}.published_at <= ${asOf}`
}

/** The category with id `categoryId` has a public listing: its page renders (#341, #346). */
function categoryRenders(categoryId: string, asOf: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM listing_categories render_lc INDEXED BY listing_categories_category_idx
    CROSS JOIN listings render_l ON render_l.id = render_lc.listing_id
    WHERE render_lc.category_id = ${sql.raw(categoryId)} AND ${publicListing('render_l', asOf)})`
}

/**
 * The target of a `taxonomy_redirects` row `r` (joined with `TAXONOMY_TARGET_JOINS`) renders,
 * by its own page's rule (#346 review), so a moved URL never answers 308 to a 404: a category or
 * tag with a public listing (a tag under an active hub, as the tag stats count it), a best page
 * with an entry (a public pin, or a public listing of its pool that it does not exclude), or the
 * directory. The catalog's `getTaxonomyRedirect` applies the same rule from its cached reads.
 */
function taxonomyTargetRenders(asOf: string): SQL {
  return sql`CASE r.target_kind
    WHEN 'directory' THEN 1
    WHEN 'category' THEN ${categoryRenders('target_c.id', asOf)}
    WHEN 'tag' THEN EXISTS (
        SELECT 1 FROM categories render_hub
        WHERE render_hub.id = target_t.category_id AND render_hub.is_active = 1
      ) AND EXISTS (
        SELECT 1 FROM listing_tags render_lt INDEXED BY listing_tags_tag_idx
        CROSS JOIN listings render_l ON render_l.id = render_lt.listing_id
        WHERE render_lt.tag_id = target_t.id AND ${publicListing('render_l', asOf)})
    WHEN 'best' THEN EXISTS (
        SELECT 1 FROM best_page_listings render_pin
        CROSS JOIN listings render_l ON render_l.id = render_pin.listing_id
        WHERE render_pin.best_page_id = target_b.id AND render_pin.excluded = 0
          AND ${publicListing('render_l', asOf)}
      ) OR EXISTS (
        SELECT 1 FROM listing_tags render_lt INDEXED BY listing_tags_tag_idx
        CROSS JOIN listings render_l ON render_l.id = render_lt.listing_id
        WHERE render_lt.tag_id = target_b.tag_id AND ${publicListing('render_l', asOf)}
          AND (target_b.category_id IS NULL OR EXISTS (
            SELECT 1 FROM listing_categories render_in
            WHERE render_in.listing_id = render_l.id AND render_in.category_id = target_b.category_id
          ))
          AND NOT EXISTS (
            SELECT 1 FROM best_page_listings render_out
            WHERE render_out.best_page_id = target_b.id AND render_out.listing_id = render_l.id
              AND render_out.excluded = 1
          )
      ) OR (target_b.tag_id IS NULL AND EXISTS (
        SELECT 1 FROM listing_categories render_lc INDEXED BY listing_categories_category_idx
        CROSS JOIN listings render_l ON render_l.id = render_lc.listing_id
        WHERE render_lc.category_id = target_b.category_id AND ${publicListing('render_l', asOf)}
          AND NOT EXISTS (
            SELECT 1 FROM best_page_listings render_out
            WHERE render_out.best_page_id = target_b.id AND render_out.listing_id = render_l.id
              AND render_out.excluded = 1
          )
      ))
    ELSE 0
  END`
}

/**
 * Where `/<slug>` moved: a public listing or a category with a public listing with that slug, or
 * (`moved`) the target of the retired category URL it names.
 */
export type LegacyRootTarget =
  | { kind: 'category' | 'listing'; slug: string }
  | { kind: 'moved'; target: TaxonomyTarget }

interface LegacyRootRow {
  kind: string
  rank: number
  slug: string | null
}

/**
 * Where an old root-level URL `/<slug>` moved (#168), in one hop, or null:
 *
 * 1. a public listing with that slug;
 * 2. an active category with that slug and a public listing (its page renders);
 * 3. a retired listing slug (`listing_slug_redirects`: a rename, or an unpublished duplicate,
 *    #338) followed to its public listing's current slug (#356);
 * 4. a retired category URL, or one with no public listing left (`taxonomy_redirects`, #341
 *    design 2.2), followed to its active target when that target renders (#346 review).
 *
 * Each branch is one seek on a unique key (plus one for its target, and an `EXISTS` that stops at
 * the first public listing that shows the page renders), and the four are one compound SELECT
 * within D1's limit of five terms, so the Worker entry answers the one 308 itself instead of
 * letting Next.js redirect after the trailing-slash rule (two hops). Rendering wins, as on the
 * hub route: a category with a public listing renders even when a redirect row names it.
 */
export async function legacyRootTarget(input: {
  asOf: string
  client: Database
  observe?: CatalogObserver
  slug: string
}): Promise<LegacyRootTarget | null> {
  const startedAt = performance.now()
  let rowsRead: number | null = null
  let d1DurationMs: number | null = null
  let success = false
  let resultRows = 0
  let errorCode: string | undefined
  try {
    const result = await runQuery<LegacyRootRow>(
      input.client,
      sql<LegacyRootRow>`SELECT kind, slug, rank FROM (
          SELECT 'listing' AS kind, slug, 0 AS rank FROM listings
            WHERE slug = ${input.slug} AND status = 'approved' AND is_active = 1
              AND published_at IS NOT NULL AND published_at <= ${input.asOf}
          UNION ALL
          SELECT 'category' AS kind, c.slug, 1 AS rank FROM categories c
            WHERE c.slug = ${input.slug} AND c.is_active = 1
              AND ${categoryRenders('c.id', input.asOf)}
          UNION ALL
          SELECT 'listing' AS kind, l.slug, 2 AS rank FROM listing_slug_redirects old
            JOIN listings l ON l.id = old.listing_id
            WHERE old.old_slug = ${input.slug} AND l.status = 'approved' AND l.is_active = 1
              AND l.published_at IS NOT NULL AND l.published_at <= ${input.asOf}
          UNION ALL
          SELECT r.target_kind AS kind, ${sql.raw(TAXONOMY_TARGET_SLUG)} AS slug, 3 AS rank
            FROM taxonomy_redirects r
            ${sql.raw(TAXONOMY_TARGET_JOINS)}
            WHERE r.source_kind = 'category' AND r.source_slug = ${input.slug}
              AND (r.target_kind = 'directory' OR ${sql.raw(TAXONOMY_TARGET_SLUG)} IS NOT NULL)
              AND ${taxonomyTargetRenders(input.asOf)}
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
    const row = result.results[0]
    if (!row) return null
    if (row.rank === 3) {
      const target = parseTaxonomyTarget(row.kind, row.slug)
      return target && { kind: 'moved', target }
    }
    if ((row.kind !== 'category' && row.kind !== 'listing') || typeof row.slug !== 'string') {
      throw new Error('Invalid D1 root-level target.')
    }
    return { kind: row.kind, slug: row.slug }
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
