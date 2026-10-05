import 'server-only'

import { and, eq, type SQL, sql } from 'drizzle-orm'
import {
  type CatalogEpoch,
  catalogEpochStatement,
  catalogEpochToken,
  parseCatalogEpoch
} from './catalog-epoch'
import { type CompiledQuery, d1ErrorCode, runQuery } from './client'
import type {
  CatalogCacheEvent,
  CatalogOperation,
  CatalogOperations,
  CatalogOperationsConfig,
  CatalogQueryEvent,
  CatalogQueryShape,
  CatalogShellStats,
  ListingDetail,
  ListingLinkRel,
  ListingNamePage,
  ListingNamePageQuery,
  ListingNavigation,
  ListingResourceLink,
  ListingSummary,
  PublishedCategory,
  RelatedListing,
  UnpublishedListing
} from './contracts'
import { listingSlugRedirects, listings } from './schema'

/** v4: listing details carry `linkRel` and `verifiedOwner` (#62). */
const CACHE_SCHEMA = 'v4'
/**
 * Keys include the catalog epoch (publication version plus the latest public
 * `published_at`), so an entry can never outlive the content it was built from; the TTL
 * only bounds storage.
 */
const CACHE_TTL_SECONDS = 24 * 60 * 60
const PUBLICATION_ORDER = 'l.published_at DESC, l.display_order ASC, l.slug ASC'
/** Directory pages show this many listings unless a caller asks for another size. */
export const LISTING_PAGE_SIZE = 48
const MAX_LISTING_PAGE_SIZE = 100
/** Search input past these bounds is ignored, never rejected (#77). */
export const MAX_SEARCH_QUERY_CHARS = 100
export const MAX_SEARCH_TERMS = 8
export const MAX_SEARCH_LIMIT = 100

/**
 * The search phrase and its distinct terms: ASCII letters lowercased, control characters and
 * runs of whitespace collapsed to one space, cut to `MAX_SEARCH_QUERY_CHARS` code points and
 * `MAX_SEARCH_TERMS` terms. Both sides fold the same way: SQLite's `lower()` folds only ASCII,
 * so matching is case-insensitive for ASCII letters and exact (as typed, no Unicode case
 * folding or normalization) for every other character (#81 review).
 */
export function normalizeSearchQuery(query: string): { phrase: string; terms: string[] } {
  const collapsed = query
    .replace(/[A-Z]+/gu, letters => letters.toLowerCase())
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
  const phrase = Array.from(collapsed).slice(0, MAX_SEARCH_QUERY_CHARS).join('').trim()
  const terms = [...new Set(phrase.split(' ').filter(Boolean))].slice(0, MAX_SEARCH_TERMS)
  return { phrase, terms }
}

/**
 * The lowercased host of `l.website` (`https://www.jasper.ai/x` -> `www.jasper.ai`), so a term
 * matches the domain but not the scheme or path. Only string functions on the same row: no
 * extra rows read.
 */
const WEBSITE_AFTER_SCHEME = "substr(l.website, instr(l.website, '://') + 3)"
const WEBSITE_HOST_SQL = `lower(CASE WHEN instr(${WEBSITE_AFTER_SCHEME}, '/') > 0
  THEN substr(${WEBSITE_AFTER_SCHEME}, 1, instr(${WEBSITE_AFTER_SCHEME}, '/') - 1)
  ELSE ${WEBSITE_AFTER_SCHEME} END)`

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
/**
 * A single-category listing's related candidates are read from its category's members
 * when the category is at most this large; larger (dense) categories walk the name index
 * instead, which finds four members after a handful of rows. Both plans return the same
 * rows; this only picks the cheaper one (see DATA_MODEL.md).
 */
const RELATED_MEMBER_SCAN_LIMIT = 128
const runtimePriorities = new Set(['high', 'medium', 'low'])
const runtimeLinkRels = new Set<string>(['follow', 'nofollow', 'sponsored'])
/** Directory name order is the locale order the pages have always used (`localeCompare`). */
const nameCollator = new Intl.Collator()

interface QueryMeta {
  duration?: number
  rows_read?: number
  rows_written?: number
}

interface SummaryRow {
  categories: string | null
  category: string
  description: string
  display_order: number
  id: string
  is_featured: number
  is_unofficial: number
  logo: string | null
  name: string
  published_at: string
  slug: string
  website: string
}

interface DetailRow extends SummaryRow {
  content: string | null
  entity_type: string | null
  images: string
  link_rel: string
  priority: string | null
  resource_links: string
  verified_owner: number
  video: string | null
}

interface UnpublishedRow {
  category: string | null
  name: string
  slug: string
}

interface NavigationRow {
  logo: string | null
  name: string
  slug: string
  website: string
}

interface RelatedRow {
  description: string
  id: string
  is_unofficial: number
  logo: string | null
  name: string
  slug: string
  website: string
}

interface NameOrderRow {
  id: string
  name: string
  published_at: string
}

interface ShellRow {
  categories: string
  featured_count: number
  listing_count: number
}

/**
 * Catalog reads retain their reviewed SQL shapes because D1 metadata and the
 * query-plan benchmarks are part of the public runtime contract. Drizzle's query
 * builder maps rows but discards the raw D1 response metadata, so these statements
 * use typed raw SQL with every runtime value represented by a Drizzle parameter.
 */
function parameterizedQuery<T>(text: string, bindings: unknown[]): SQL<T> {
  const fragments = text.split('?')
  if (fragments.length !== bindings.length + 1) {
    throw new Error(
      `Catalog query expected ${fragments.length - 1} bindings but received ${bindings.length}.`
    )
  }

  let query = sql.raw(fragments[0] || '')
  for (const [index, binding] of bindings.entries()) {
    query = sql`${query}${sql.param(binding)}${sql.raw(fragments[index + 1] || '')}`
  }
  return query as SQL<T>
}

function finiteMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function publicEligibilitySql(alias = 'l'): string {
  return `${alias}.status = 'approved' AND ${alias}.is_active = 1 AND ${alias}.published_at IS NOT NULL AND ${alias}.published_at <= ?`
}

const summaryColumns = `
  l.id,
  l.slug,
  l.name,
  l.description,
  l.website,
  l.display_order,
  l.is_unofficial,
  l.is_featured,
  l.published_at,
  (
    SELECT c.slug
    FROM listing_categories lc
    JOIN categories c ON c.id = lc.category_id
    WHERE lc.listing_id = l.id AND lc.is_primary = 1 AND c.is_active = 1
    LIMIT 1
  ) AS category,
  (
    SELECT group_concat(ordered.slug, char(31))
    FROM (
      SELECT c.slug
      FROM listing_categories lc
      JOIN categories c ON c.id = lc.category_id
      WHERE lc.listing_id = l.id AND c.is_active = 1
      ORDER BY lc.is_primary DESC, lc.sort_order ASC, c.slug ASC
    ) ordered
  ) AS categories,
  (
    SELECT m.url
    FROM listing_media m
    WHERE m.listing_id = l.id AND m.kind = 'logo'
    ORDER BY m.sort_order ASC
    LIMIT 1
  ) AS logo`

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid D1 ${field}.`)
  return value
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid D1 ${field}.`)
  return value as number
}

function parseJsonArray(value: string, field: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  throw new Error(`Invalid D1 ${field}.`)
}

function mapSummary(row: SummaryRow): ListingSummary {
  const category = requireString(row.category, 'primary category')
  const categories = (row.categories || '')
    .split(String.fromCharCode(31))
    .filter(Boolean)
    .map(value => requireString(value, 'category slug'))
  if (!categories.includes(category))
    throw new Error(`Invalid D1 listing ${row.slug}: primary category is missing.`)

  return {
    categories,
    category,
    description: requireString(row.description, 'listing description'),
    featured: row.is_featured === 1 || undefined,
    isUnofficial: row.is_unofficial === 1 || undefined,
    media: row.logo ? { logo: requireString(row.logo, 'listing logo') } : undefined,
    name: requireString(row.name, 'listing name'),
    publishedAt: requireString(row.published_at, 'publication date').slice(0, 10),
    slug: requireString(row.slug, 'listing slug'),
    website: requireString(row.website, 'listing website')
  }
}

function mapNavigation(row: NavigationRow | undefined): ListingNavigation | null {
  if (!row) return null
  return {
    media: row.logo ? { logo: requireString(row.logo, 'navigation logo') } : undefined,
    name: requireString(row.name, 'navigation name'),
    slug: requireString(row.slug, 'navigation slug'),
    website: requireString(row.website, 'navigation website')
  }
}

function mapDetail(
  row: DetailRow
): Omit<ListingDetail, 'nextWebsite' | 'previousWebsite' | 'relatedWebsites'> {
  const summary = mapSummary(row)
  const imageValues = parseJsonArray(row.images, 'listing images')
  const resourceValues = parseJsonArray(row.resource_links, 'listing resource links')
  const images = imageValues.map((value, index) =>
    requireString(value, `listing image ${index + 1}`)
  )
  const resources: ListingResourceLink[] = resourceValues.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid D1 resource ${index + 1}.`)
    const resource = value as Record<string, unknown>
    return {
      label: requireString(resource.label, `resource ${index + 1} label`),
      url: requireString(resource.url, `resource ${index + 1} URL`)
    }
  })
  const priority =
    typeof row.priority === 'string' && runtimePriorities.has(row.priority)
      ? (row.priority as 'high' | 'low' | 'medium')
      : undefined
  const logo = summary.media?.logo
  const video = row.video || undefined
  if (!runtimeLinkRels.has(row.link_rel))
    throw new Error(`Invalid D1 listing ${row.slug} link rel.`)

  return {
    ...summary,
    content: row.content || undefined,
    entityType: row.entity_type || undefined,
    linkRel: row.link_rel as ListingLinkRel,
    media:
      logo || video || images.length
        ? {
            logo,
            images: images.length ? images : undefined,
            video
          }
        : undefined,
    priority,
    resourceLinks: resources.length ? resources : undefined,
    verifiedOwner: row.verified_owner === 1 || undefined
  }
}

function isShellStats(value: unknown, publicationVersion: number): value is CatalogShellStats {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CatalogShellStats>
  return (
    candidate.publicationVersion === publicationVersion &&
    Number.isSafeInteger(candidate.featuredCount) &&
    (candidate.featuredCount as number) >= 0 &&
    Number.isSafeInteger(candidate.listingCount) &&
    (candidate.listingCount as number) >= 0 &&
    Array.isArray(candidate.categories) &&
    candidate.categories.every(
      category =>
        category &&
        typeof category.slug === 'string' &&
        typeof category.name === 'string' &&
        typeof category.description === 'string' &&
        Number.isSafeInteger(category.order) &&
        Number.isSafeInteger(category.count) &&
        category.count >= 0
    )
  )
}

interface PublishedCacheEntry {
  items: ListingSummary[]
  publicationVersion: number
}

interface DetailCacheEntry {
  detail: ListingDetail | null
  publicationVersion: number
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0)
}

function isLogoMedia(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  return isOptionalString((value as { logo?: unknown }).logo)
}

function isListingSummary(value: unknown): value is ListingSummary {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ListingSummary>
  return (
    typeof candidate.category === 'string' &&
    candidate.category.length > 0 &&
    Array.isArray(candidate.categories) &&
    candidate.categories.every(category => typeof category === 'string' && category.length > 0) &&
    candidate.categories.includes(candidate.category) &&
    typeof candidate.description === 'string' &&
    isOptionalBoolean(candidate.featured) &&
    isOptionalBoolean(candidate.isUnofficial) &&
    isLogoMedia(candidate.media) &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.publishedAt === 'string' &&
    candidate.publishedAt.length > 0 &&
    typeof candidate.slug === 'string' &&
    candidate.slug.length > 0 &&
    typeof candidate.website === 'string' &&
    candidate.website.length > 0
  )
}

function isNavigation(value: unknown): value is ListingNavigation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ListingNavigation>
  return (
    isLogoMedia(candidate.media) &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.slug === 'string' &&
    candidate.slug.length > 0 &&
    typeof candidate.website === 'string' &&
    candidate.website.length > 0
  )
}

function isRelatedListing(value: unknown): value is RelatedListing {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RelatedListing>
  return (
    typeof candidate.description === 'string' &&
    isOptionalBoolean(candidate.isUnofficial) &&
    isLogoMedia(candidate.media) &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.slug === 'string' &&
    candidate.slug.length > 0 &&
    typeof candidate.website === 'string' &&
    candidate.website.length > 0
  )
}

function isDetailMedia(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const candidate = value as { images?: unknown; logo?: unknown; video?: unknown }
  return (
    (candidate.images === undefined ||
      (Array.isArray(candidate.images) &&
        candidate.images.every(image => typeof image === 'string' && image.length > 0))) &&
    isOptionalString(candidate.logo) &&
    isOptionalString(candidate.video)
  )
}

function isListingDetail(value: unknown): value is ListingDetail {
  if (!isListingSummary(value)) return false
  const candidate = value as ListingDetail
  return (
    isOptionalString(candidate.content) &&
    isOptionalString(candidate.entityType) &&
    runtimeLinkRels.has(candidate.linkRel) &&
    (candidate.verifiedOwner === undefined || candidate.verifiedOwner === true) &&
    isDetailMedia(candidate.media) &&
    (candidate.nextWebsite === null || isNavigation(candidate.nextWebsite)) &&
    (candidate.previousWebsite === null || isNavigation(candidate.previousWebsite)) &&
    (candidate.priority === undefined || runtimePriorities.has(candidate.priority)) &&
    Array.isArray(candidate.relatedWebsites) &&
    candidate.relatedWebsites.every(isRelatedListing) &&
    (candidate.resourceLinks === undefined ||
      (Array.isArray(candidate.resourceLinks) &&
        candidate.resourceLinks.every(
          resource =>
            resource &&
            typeof resource.label === 'string' &&
            resource.label.length > 0 &&
            typeof resource.url === 'string' &&
            resource.url.length > 0
        )))
  )
}

function isPublishedCacheEntry(
  value: unknown,
  publicationVersion: number
): value is PublishedCacheEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PublishedCacheEntry>
  return (
    candidate.publicationVersion === publicationVersion &&
    Array.isArray(candidate.items) &&
    candidate.items.every(isListingSummary)
  )
}

function isDetailCacheEntry(value: unknown, publicationVersion: number): value is DetailCacheEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DetailCacheEntry>
  return (
    candidate.publicationVersion === publicationVersion &&
    (candidate.detail === null || isListingDetail(candidate.detail))
  )
}

interface NameOrderEntry {
  firstPublishedAt: string | null
  ids: string[]
  lastPublishedAt: string | null
  publicationVersion: number
}

interface NamePageEntry {
  page: ListingNamePage
  publicationVersion: number
}

function isNullableString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0)
}

function isNameOrderEntry(value: unknown, publicationVersion: number): value is NameOrderEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NameOrderEntry>
  return (
    candidate.publicationVersion === publicationVersion &&
    Array.isArray(candidate.ids) &&
    candidate.ids.every(id => typeof id === 'string' && id.length > 0) &&
    isNullableString(candidate.firstPublishedAt) &&
    isNullableString(candidate.lastPublishedAt)
  )
}

function isNamePageEntry(value: unknown, publicationVersion: number): value is NamePageEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NamePageEntry>
  const page = candidate.page as Partial<ListingNamePage> | undefined
  return (
    candidate.publicationVersion === publicationVersion &&
    !!page &&
    typeof page === 'object' &&
    (page.category === null || (typeof page.category === 'string' && page.category.length > 0)) &&
    isNullableString(page.firstPublishedAt) &&
    isNullableString(page.lastPublishedAt) &&
    Array.isArray(page.items) &&
    page.items.every(isListingSummary) &&
    [page.page, page.pageCount, page.pageSize, page.total].every(
      value => Number.isSafeInteger(value) && (value as number) >= 0
    )
  )
}

export function createCatalogOperations(config: CatalogOperationsConfig): CatalogOperations {
  const { cache, client, clock, observe } = config
  let epochPromise: Promise<CatalogEpoch> | undefined
  let publishedListingsPromise: Promise<ListingSummary[]> | undefined
  let shellStatsPromise: Promise<CatalogShellStats> | undefined
  const detailPromises = new Map<string, Promise<ListingDetail | null>>()
  const nameOrderPromises = new Map<string, Promise<NameOrderEntry>>()

  async function queryAll<T>(
    operation: CatalogOperation,
    queryShape: CatalogQueryShape,
    statement: CompiledQuery | SQL<T>
  ): Promise<T[]> {
    const startedAt = performance.now()
    let eventEmitted = false
    try {
      const result = await runQuery<T>(client, statement)
      const meta = result.meta as QueryMeta
      const event: CatalogQueryEvent = {
        d1DurationMs: finiteMetric(meta?.duration),
        event: 'd1_query',
        operation,
        queryShape,
        resultRows: result.results.length,
        rowsRead: finiteMetric(meta?.rows_read),
        rowsWritten: finiteMetric(meta?.rows_written),
        success: result.success,
        wallDurationMs: performance.now() - startedAt
      }
      observe(event)
      eventEmitted = true
      if (!result.success) throw new Error('D1 catalog query failed.')
      return result.results
    } catch (error) {
      if (!eventEmitted) {
        observe({
          d1DurationMs: null,
          errorCode: d1ErrorCode(error),
          event: 'd1_query',
          operation,
          queryShape,
          resultRows: 0,
          rowsRead: null,
          rowsWritten: null,
          success: false,
          wallDurationMs: performance.now() - startedAt
        })
      }
      throw error
    }
  }

  async function readCache<T>(
    operation: CatalogCacheEvent['operation'],
    cacheKey: string,
    validate: (value: unknown) => value is T
  ): Promise<T | null> {
    try {
      const cached = await cache.get(cacheKey)
      if (cached === null) {
        observe({ event: 'catalog_cache', operation, state: 'miss' })
        return null
      }
      if (validate(cached)) {
        observe({ event: 'catalog_cache', operation, state: 'hit' })
        return cached
      }
      observe({ event: 'catalog_cache', operation, state: 'corrupt' })
    } catch {
      observe({ event: 'catalog_cache', operation, state: 'error' })
    }
    return null
  }

  async function writeCache(
    operation: CatalogCacheEvent['operation'],
    cacheKey: string,
    value: unknown
  ): Promise<void> {
    try {
      await cache.put(cacheKey, value, CACHE_TTL_SECONDS)
      observe({ event: 'catalog_cache', operation, state: 'written' })
    } catch {
      observe({ event: 'catalog_cache', operation, state: 'write-error' })
    }
  }

  function operationTime(): string {
    const value = clock()
    if (Number.isNaN(value.getTime())) throw new Error('Catalog clock returned an invalid date.')
    return value.toISOString()
  }

  async function summaries(
    operation: CatalogOperation,
    queryShape: CatalogQueryShape,
    extraWhere: string,
    extraBindings: unknown[],
    orderBy: string,
    limit?: number,
    offset?: number
  ): Promise<ListingSummary[]> {
    const asOf = operationTime()
    const pagination =
      limit === undefined ? '' : ` LIMIT ?${offset === undefined ? '' : ' OFFSET ?'}`
    const rows = await queryAll<SummaryRow>(
      operation,
      queryShape,
      parameterizedQuery<SummaryRow>(
        `SELECT ${summaryColumns} FROM listings l WHERE ${publicEligibilitySql()}${extraWhere} ORDER BY ${orderBy}${pagination}`,
        [
          asOf,
          ...extraBindings,
          ...(limit === undefined ? [] : [limit]),
          ...(offset === undefined ? [] : [offset])
        ]
      )
    )
    return rows.map(mapSummary)
  }

  async function queryCatalogEpoch(): Promise<CatalogEpoch> {
    const rows = await queryAll(
      'publication-version',
      'publication-version',
      catalogEpochStatement(operationTime())
    )
    return parseCatalogEpoch(rows[0])
  }

  function getCatalogEpoch(): Promise<CatalogEpoch> {
    if (!epochPromise) {
      const reused = config.reuseEpoch?.() ?? null
      epochPromise = reused ? Promise.resolve(reused) : queryCatalogEpoch()
    }
    return epochPromise
  }

  async function getPublicationVersion(): Promise<number> {
    return (await getCatalogEpoch()).version
  }

  /** Cache key prefix for the current epoch: `<kind>:<schema>:<epoch token>`. */
  async function epochKey(kind: string): Promise<{ key: string; publicationVersion: number }> {
    const epoch = await getCatalogEpoch()
    return {
      key: `${kind}:${CACHE_SCHEMA}:${catalogEpochToken(epoch)}`,
      publicationVersion: epoch.version
    }
  }

  async function loadShellStats(): Promise<CatalogShellStats> {
    const { key: cacheKey, publicationVersion } = await epochKey('catalog-shell')
    const cached = await readCache('shell-stats', cacheKey, (value): value is CatalogShellStats =>
      isShellStats(value, publicationVersion)
    )
    if (cached) return cached

    const asOf = operationTime()
    // One pass over public memberships instead of a correlated count per category, which
    // read categories x listings rows (~487k on the live catalog). Every public listing has
    // exactly one primary category (enforced by the baseline triggers), so the listing and
    // featured totals are sums of primary memberships from the same pass.
    const rows = await queryAll<ShellRow>(
      'shell-stats',
      'shell-stats',
      parameterizedQuery<ShellRow>(
        `WITH membership_counts AS (
          SELECT
            lc.category_id,
            COUNT(*) AS listing_count,
            SUM(lc.is_primary) AS primary_count,
            SUM(CASE WHEN lc.is_primary = 1 AND l.is_featured = 1 THEN 1 ELSE 0 END)
              AS featured_primary_count
          FROM listings l
          JOIN listing_categories lc ON lc.listing_id = l.id
          WHERE ${publicEligibilitySql()}
          GROUP BY lc.category_id
        )
        SELECT
        COALESCE((
          SELECT json_group_array(json_object(
            'slug', counts.slug,
            'name', counts.name,
            'description', counts.description,
            'order', counts.sort_order,
            'count', counts.listing_count
          ))
          FROM (
            SELECT
              c.slug,
              c.name,
              c.description,
              c.sort_order,
              COALESCE(membership_counts.listing_count, 0) AS listing_count
            FROM categories c
            LEFT JOIN membership_counts ON membership_counts.category_id = c.id
            WHERE c.is_active = 1
            ORDER BY c.sort_order ASC, c.name ASC
          ) counts
        ), '[]') AS categories,
        COALESCE((SELECT SUM(featured_primary_count) FROM membership_counts), 0)
          AS featured_count,
        COALESCE((SELECT SUM(primary_count) FROM membership_counts), 0) AS listing_count`,
        [asOf]
      )
    )
    const row = rows[0]
    if (!row) throw new Error('Missing D1 shell statistics.')
    const categories: PublishedCategory[] = parseJsonArray(row.categories, 'shell categories').map(
      (value, index) => {
        if (!value || typeof value !== 'object')
          throw new Error(`Invalid D1 shell category ${index + 1}.`)
        const category = value as Record<string, unknown>
        return {
          count: requireNonNegativeInteger(category.count, `category ${index + 1} count`),
          description: typeof category.description === 'string' ? category.description : '',
          name: requireString(category.name, `category ${index + 1} name`),
          order: requireNonNegativeInteger(category.order, `category ${index + 1} order`),
          slug: requireString(category.slug, `category ${index + 1} slug`)
        }
      }
    )
    const stats: CatalogShellStats = {
      categories,
      featuredCount: requireNonNegativeInteger(row.featured_count, 'featured count'),
      listingCount: requireNonNegativeInteger(row.listing_count, 'listing count'),
      publicationVersion
    }
    await writeCache('shell-stats', cacheKey, stats)
    return stats
  }

  function getShellStats(): Promise<CatalogShellStats> {
    shellStatsPromise ||= loadShellStats()
    return shellStatsPromise
  }

  /**
   * Adjacent listing in publication order. The three keyset branches (same publication
   * time and display order, same publication time, earlier/later publication) are each an
   * index seek. They run as one statement whose COALESCE only evaluates a branch when the
   * previous ones found nothing, so a detail page needs one round trip per direction
   * instead of up to three sequential ones, without reading more rows.
   */
  async function navigation(
    current: Pick<SummaryRow, 'display_order' | 'published_at' | 'slug'>,
    asOf: string,
    direction: 'next' | 'previous'
  ): Promise<ListingNavigation | null> {
    const isPrevious = direction === 'previous'
    const branches = isPrevious
      ? [
          {
            bindings: [current.published_at, current.display_order, current.slug],
            order: 'l.slug DESC',
            predicate: 'l.published_at = ? AND l.display_order = ? AND l.slug < ?'
          },
          {
            bindings: [current.published_at, current.display_order],
            order: 'l.display_order DESC, l.slug DESC',
            predicate: 'l.published_at = ? AND l.display_order < ?'
          },
          {
            bindings: [current.published_at],
            order: 'l.published_at ASC, l.display_order DESC, l.slug DESC',
            predicate: 'l.published_at > ?'
          }
        ]
      : [
          {
            bindings: [current.published_at, current.display_order, current.slug],
            order: 'l.slug ASC',
            predicate: 'l.published_at = ? AND l.display_order = ? AND l.slug > ?'
          },
          {
            bindings: [current.published_at, current.display_order],
            order: 'l.display_order ASC, l.slug ASC',
            predicate: 'l.published_at = ? AND l.display_order > ?'
          },
          {
            bindings: [current.published_at],
            order: PUBLICATION_ORDER,
            predicate: 'l.published_at < ?'
          }
        ]

    const rows = await queryAll<NavigationRow>(
      'listing-detail',
      isPrevious ? 'navigation-previous' : 'navigation-next',
      parameterizedQuery<NavigationRow>(
        `SELECT
        l.slug,
        l.name,
        l.website,
        (
          SELECT m.url FROM listing_media m
          WHERE m.listing_id = l.id AND m.kind = 'logo'
          ORDER BY m.sort_order ASC LIMIT 1
        ) AS logo
      FROM listings l
      WHERE l.id = COALESCE(
        ${branches
          .map(
            branch => `(
          SELECT l.id
          FROM listings l
          WHERE ${publicEligibilitySql()} AND ${branch.predicate}
          ORDER BY ${branch.order}
          LIMIT 1
        )`
          )
          .join(',\n        ')}
      )
      LIMIT 1`,
        branches.flatMap(branch => [asOf, ...branch.bindings])
      )
    )
    return mapNavigation(rows[0])
  }

  async function queryListingBySlug(slug: string): Promise<ListingDetail | null> {
    const asOf = operationTime()
    const rows = await queryAll<DetailRow>(
      'listing-detail',
      'listing-detail',
      parameterizedQuery<DetailRow>(
        `SELECT
        ${summaryColumns},
        l.content,
        l.entity_type,
        l.priority,
        l.link_rel,
        EXISTS (
          SELECT 1 FROM listing_owners o
          WHERE o.listing_id = l.id AND o.role = 'owner' AND o.revoked_at IS NULL
        ) AS verified_owner,
        COALESCE((
          SELECT json_group_array(ordered.url)
          FROM (
            SELECT m.url FROM listing_media m
            WHERE m.listing_id = l.id AND m.kind = 'image'
            ORDER BY m.sort_order ASC
          ) ordered
        ), '[]') AS images,
        (
          SELECT m.url FROM listing_media m
          WHERE m.listing_id = l.id AND m.kind = 'video'
          ORDER BY m.sort_order ASC LIMIT 1
        ) AS video,
        COALESCE((
          SELECT json_group_array(json_object('label', ordered.label, 'url', ordered.url))
          FROM (
            SELECT r.label, r.url FROM listing_resource_links r
            WHERE r.listing_id = l.id
            ORDER BY r.sort_order ASC
          ) ordered
        ), '[]') AS resource_links
      FROM listings l
      WHERE ${publicEligibilitySql()} AND l.slug = ?
      LIMIT 1`,
        [asOf, slug]
      )
    )
    const row = rows[0]
    if (!row) return null

    const [relatedWebsites, previousWebsite, nextWebsite] = await Promise.all([
      relatedListings(row, asOf),
      navigation(row, asOf, 'previous'),
      navigation(row, asOf, 'next')
    ])
    return {
      ...mapDetail(row),
      nextWebsite,
      previousWebsite,
      relatedWebsites
    }
  }

  /**
   * Up to four related listings ranked by shared categories (most first), then name and
   * slug. One statement, with each related logo resolved only for the returned rows.
   *
   * - Several categories: count shared memberships from the listing's own categories
   *   (bounded by the size of those categories).
   * - One category: read that category's members when it is small, otherwise walk the
   *   public name index, where a dense category yields four members almost immediately.
   */
  async function relatedListings(row: DetailRow, asOf: string): Promise<RelatedListing[]> {
    const sharedCategoryCount = (row.categories || '')
      .split(String.fromCharCode(31))
      .filter(Boolean).length
    let queryShape: CatalogQueryShape
    let candidates: string
    let bindings: unknown[]
    if (sharedCategoryCount > 1) {
      queryShape = 'related-shared-categories'
      candidates = `SELECT l.id, l.slug, l.name, l.description, l.website, l.is_unofficial,
             COUNT(*) AS score
           FROM listing_categories current
           CROSS JOIN listing_categories shared INDEXED BY listing_categories_category_idx
             ON shared.category_id = current.category_id
           CROSS JOIN listings l ON l.id = shared.listing_id
           WHERE current.listing_id = ?
             AND shared.listing_id != current.listing_id
             AND ${publicEligibilitySql()}
           GROUP BY l.id
           ORDER BY score DESC, l.name ASC, l.slug ASC
           LIMIT 4`
      bindings = [row.id, asOf]
    } else {
      const categorySize = (await getShellStats()).categories.find(
        category => category.slug === row.category
      )?.count
      const currentCategory = `(
               SELECT current.category_id
               FROM listing_categories current
               WHERE current.listing_id = ?
               LIMIT 1
             )`
      if (categorySize !== undefined && categorySize <= RELATED_MEMBER_SCAN_LIMIT) {
        queryShape = 'related-single-category-members'
        candidates = `SELECT l.id, l.slug, l.name, l.description, l.website, l.is_unofficial,
             1 AS score
           FROM listing_categories shared INDEXED BY listing_categories_category_idx
           CROSS JOIN listings l ON l.id = shared.listing_id
           WHERE shared.category_id = ${currentCategory}
             AND ${publicEligibilitySql()}
             AND l.id != ?
           ORDER BY l.name ASC, l.slug ASC
           LIMIT 4`
        bindings = [row.id, asOf, row.id]
      } else {
        queryShape = 'related-single-category-seek'
        candidates = `SELECT l.id, l.slug, l.name, l.description, l.website, l.is_unofficial,
             1 AS score
           FROM listings l INDEXED BY listings_related_name_idx
           WHERE ${publicEligibilitySql()}
             AND l.id != ?
             AND EXISTS (
               SELECT 1
               FROM listing_categories shared
               WHERE shared.listing_id = l.id
                 AND shared.category_id = ${currentCategory}
             )
           ORDER BY l.name ASC, l.slug ASC
           LIMIT 4`
        bindings = [asOf, row.id, row.id]
      }
    }
    const relatedRows = await queryAll<RelatedRow>(
      'listing-detail',
      queryShape,
      parameterizedQuery<RelatedRow>(
        `SELECT
        related.id,
        related.slug,
        related.name,
        related.description,
        related.website,
        related.is_unofficial,
        (
          SELECT m.url FROM listing_media m
          WHERE m.listing_id = related.id AND m.kind = 'logo'
          ORDER BY m.sort_order ASC LIMIT 1
        ) AS logo
      FROM (
        ${candidates}
      ) related
      ORDER BY related.score DESC, related.name ASC, related.slug ASC`,
        bindings
      )
    )
    return relatedRows.map(related => ({
      description: requireString(related.description, 'related description'),
      isUnofficial: related.is_unofficial === 1 || undefined,
      media: related.logo ? { logo: requireString(related.logo, 'related logo') } : undefined,
      name: requireString(related.name, 'related name'),
      slug: requireString(related.slug, 'related slug'),
      website: requireString(related.website, 'related website')
    }))
  }

  async function loadListingBySlug(slug: string): Promise<ListingDetail | null> {
    const { key, publicationVersion } = await epochKey('catalog-detail')
    const cacheKey = `${key}:${slug}`
    const cached = await readCache('listing-detail', cacheKey, (value): value is DetailCacheEntry =>
      isDetailCacheEntry(value, publicationVersion)
    )
    if (cached) return cached.detail

    const detail = await queryListingBySlug(slug)
    await writeCache('listing-detail', cacheKey, { detail, publicationVersion })
    return detail
  }

  /**
   * One index seek on the unique slug. Uncached: it only runs after a detail lookup missed,
   * and an unpublished listing has no public epoch-keyed content to share.
   */
  async function getUnpublishedListing(slug: string): Promise<UnpublishedListing | null> {
    const rows = await queryAll<UnpublishedRow>(
      'unpublished-listing',
      'unpublished-listing',
      parameterizedQuery<UnpublishedRow>(
        `SELECT
        l.slug,
        l.name,
        (
          SELECT c.slug
          FROM listing_categories lc
          JOIN categories c ON c.id = lc.category_id
          WHERE lc.listing_id = l.id AND lc.is_primary = 1 AND c.is_active = 1
          LIMIT 1
        ) AS category
      FROM listings l
      WHERE l.slug = ? AND l.status = 'approved' AND l.is_active = 0
        AND l.published_at IS NOT NULL
      LIMIT 1`,
        [slug]
      )
    )
    const row = rows[0]
    if (!row) return null
    return {
      category: row.category ? requireString(row.category, 'unpublished listing category') : null,
      name: requireString(row.name, 'unpublished listing name'),
      slug: requireString(row.slug, 'unpublished listing slug')
    }
  }

  function getListingBySlug(slug: string): Promise<ListingDetail | null> {
    const existing = detailPromises.get(slug)
    if (existing) return existing
    const detail = loadListingBySlug(slug)
    detailPromises.set(slug, detail)
    return detail
  }

  async function loadPublishedListings(): Promise<ListingSummary[]> {
    const { key: cacheKey, publicationVersion } = await epochKey('catalog-published')
    const cached = await readCache(
      'published-summaries',
      cacheKey,
      (value): value is PublishedCacheEntry => isPublishedCacheEntry(value, publicationVersion)
    )
    if (cached) return cached.items

    const items = await summaries(
      'published-summaries',
      'published-summaries',
      '',
      [],
      PUBLICATION_ORDER
    )
    await writeCache('published-summaries', cacheKey, { items, publicationVersion })
    return items
  }

  function getPublishedListings(): Promise<ListingSummary[]> {
    publishedListingsPromise ||= loadPublishedListings()
    return publishedListingsPromise
  }

  /**
   * Public listing ids in directory name order, optionally within one category. The
   * order is the one the directory pages have always rendered: publication order, then a
   * stable locale sort by name. Only ids, names, and dates are read, and the result is
   * cached per epoch, so a page needs one small lookup instead of the whole catalog.
   */
  function getNameOrder(category: string | null): Promise<NameOrderEntry> {
    const key = category ?? '*'
    let order = nameOrderPromises.get(key)
    if (!order) {
      order = loadNameOrder(category)
      nameOrderPromises.set(key, order)
    }
    return order
  }

  async function loadNameOrder(category: string | null): Promise<NameOrderEntry> {
    const { key, publicationVersion } = await epochKey('catalog-name-order')
    const cacheKey = `${key}:${category ?? '*'}`
    const cached = await readCache(
      'listing-name-order',
      cacheKey,
      (value): value is NameOrderEntry => isNameOrderEntry(value, publicationVersion)
    )
    if (cached) return cached

    const asOf = operationTime()
    const rows = await queryAll<NameOrderRow>(
      'listing-name-order',
      'listing-name-order',
      category === null
        ? parameterizedQuery<NameOrderRow>(
            `SELECT l.id, l.name, l.published_at
            FROM listings l
            WHERE ${publicEligibilitySql()}
            ORDER BY ${PUBLICATION_ORDER}`,
            [asOf]
          )
        : parameterizedQuery<NameOrderRow>(
            `SELECT l.id, l.name, l.published_at
            FROM categories c
            CROSS JOIN listing_categories lc INDEXED BY listing_categories_category_idx
              ON lc.category_id = c.id
            CROSS JOIN listings l ON l.id = lc.listing_id
            WHERE c.slug = ? AND c.is_active = 1 AND ${publicEligibilitySql()}
            ORDER BY ${PUBLICATION_ORDER}`,
            [category, asOf]
          )
    )
    const ordered = rows
      .map(orderRow => ({
        id: requireString(orderRow.id, 'listing id'),
        name: requireString(orderRow.name, 'listing name'),
        publishedAt: requireString(orderRow.published_at, 'publication date').slice(0, 10)
      }))
      .sort((left, right) => nameCollator.compare(left.name, right.name))
    const dates = ordered.map(entry => entry.publishedAt).sort()
    const entry: NameOrderEntry = {
      firstPublishedAt: dates[0] ?? null,
      ids: ordered.map(orderEntry => orderEntry.id),
      lastPublishedAt: dates.at(-1) ?? null,
      publicationVersion
    }
    await writeCache('listing-name-order', cacheKey, entry)
    return entry
  }

  async function getListingNamePage(query: ListingNamePageQuery = {}): Promise<ListingNamePage> {
    const category = query.category ?? null
    const page = Math.max(1, Math.trunc(query.page ?? 1))
    const pageSize = Math.min(
      MAX_LISTING_PAGE_SIZE,
      Math.max(1, Math.trunc(query.pageSize ?? LISTING_PAGE_SIZE))
    )
    const { key, publicationVersion } = await epochKey('catalog-name-page')
    const cacheKey = `${key}:${category ?? '*'}:${pageSize}:${page}`
    const cached = await readCache('listing-name-page', cacheKey, (value): value is NamePageEntry =>
      isNamePageEntry(value, publicationVersion)
    )
    if (cached) return cached.page

    const order = await getNameOrder(category)
    const ids = order.ids.slice((page - 1) * pageSize, page * pageSize)
    const rows = ids.length
      ? await queryAll<SummaryRow>(
          'listing-name-page',
          'listing-name-page-items',
          parameterizedQuery<SummaryRow>(
            `SELECT ${summaryColumns}
            FROM json_each(?) page_ids
            CROSS JOIN listings l ON l.id = page_ids.value
            WHERE ${publicEligibilitySql()}`,
            [JSON.stringify(ids), operationTime()]
          )
        )
      : []
    const byId = new Map(rows.map(summaryRow => [summaryRow.id, mapSummary(summaryRow)]))
    const result: ListingNamePage = {
      category,
      firstPublishedAt: order.firstPublishedAt,
      items: ids.flatMap(id => {
        const item = byId.get(id)
        return item ? [item] : []
      }),
      lastPublishedAt: order.lastPublishedAt,
      page,
      pageCount: Math.max(1, Math.ceil(order.ids.length / pageSize)),
      pageSize,
      total: order.ids.length
    }
    await writeCache('listing-name-page', cacheKey, { page: result, publicationVersion })
    return result
  }

  /** First `limit` public listings in publication order, optionally featured only. */
  async function publicationHead(
    operation: 'featured-summaries' | 'latest-summaries',
    limit: number
  ): Promise<ListingSummary[]> {
    const safeLimit = Math.min(MAX_LISTING_PAGE_SIZE, Math.max(1, Math.trunc(limit)))
    const { key, publicationVersion } = await epochKey(`catalog-${operation}`)
    const cacheKey = `${key}:${safeLimit}`
    const cached = await readCache(operation, cacheKey, (value): value is PublishedCacheEntry =>
      isPublishedCacheEntry(value, publicationVersion)
    )
    if (cached) return cached.items

    const items = await summaries(
      operation,
      operation,
      operation === 'featured-summaries' ? ' AND l.is_featured = 1' : '',
      [],
      PUBLICATION_ORDER,
      safeLimit
    )
    await writeCache(operation, cacheKey, { items, publicationVersion })
    return items
  }

  /**
   * Every normalized term must occur in the listing's name, short description, slug (its
   * domain), website host, or the slug or name of one of its active categories (owner
   * decisions on #77 and #81: never the long content).
   * The terms are one JSON binding that each term reads with `json_extract(?1, '$[i]')`, and
   * matching uses `instr()`, so the statement binds four values whatever the query and has no
   * LIKE/GLOB pattern for D1's 50-byte limit. A term that matches no category name skips the
   * per-listing membership lookup (the first EXISTS runs once per statement), which keeps a
   * typical search near one read per listing. Results are cached per epoch.
   */
  async function searchListings(query: string, limit = 50): Promise<ListingSummary[]> {
    const { phrase, terms } = normalizeSearchQuery(query)
    if (terms.length === 0) return []
    const safeLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit) || 1))
    const { key, publicationVersion } = await epochKey('catalog-search')
    const cacheKey = `${key}:${safeLimit}:${await sha256Hex(JSON.stringify([phrase, terms]))}`
    const cached = await readCache(
      'search-summaries',
      cacheKey,
      (value): value is PublishedCacheEntry => isPublishedCacheEntry(value, publicationVersion)
    )
    if (cached) return cached.items

    const termClauses = terms.map((_, index) => {
      const term = `json_extract(?1, '$[${index}]')`
      const categoryText = (alias: string) =>
        `(instr(lower(${alias}.slug), ${term}) > 0 OR instr(lower(${alias}.name), ${term}) > 0)`
      return `(
            instr(lower(l.name), ${term}) > 0
            OR instr(lower(l.description), ${term}) > 0
            OR instr(lower(l.slug), ${term}) > 0
            OR instr(${WEBSITE_HOST_SQL}, ${term}) > 0
            OR (
              EXISTS (SELECT 1 FROM categories any_c WHERE any_c.is_active = 1 AND ${categoryText('any_c')})
              AND EXISTS (
                SELECT 1
                FROM listing_categories lc
                JOIN categories c ON c.id = lc.category_id
                WHERE lc.listing_id = l.id AND c.is_active = 1 AND ${categoryText('c')}
              )
            )
          )`
    })
    const statement: CompiledQuery = {
      toSQL: () => ({
        sql: `SELECT ${summaryColumns}
        FROM listings l
        WHERE l.status = 'approved' AND l.is_active = 1 AND l.published_at IS NOT NULL
          AND l.published_at <= ?2
          AND ${termClauses.join('\n          AND ')}
        ORDER BY
          CASE
            WHEN lower(l.name) = ?3 OR lower(l.slug) = ?3 THEN 0
            WHEN instr(lower(l.name), ?3) = 1 THEN 1
            WHEN instr(lower(l.name), ?3) > 0 THEN 2
            ELSE 3
          END,
          l.name ASC,
          l.slug ASC
        LIMIT ?4`,
        params: [JSON.stringify(terms), operationTime(), phrase, safeLimit]
      })
    }
    const rows = await queryAll<SummaryRow>('search-summaries', 'search-summaries', statement)
    const items = rows.map(mapSummary)
    await writeCache('search-summaries', cacheKey, { items, publicationVersion })
    return items
  }

  return {
    async getActiveCategories() {
      return (await getShellStats()).categories
    },
    async getAutocomplete(query, limit = 8) {
      return searchListings(query, limit)
    },
    async getCanonicalSlugForRedirect(oldSlug) {
      const asOf = operationTime()
      const rows = await queryAll<{ slug: string }>(
        'canonical-redirect',
        'canonical-redirect',
        client.database
          .select({ slug: listings.slug })
          .from(listingSlugRedirects)
          .innerJoin(listings, eq(listings.id, listingSlugRedirects.listingId))
          .where(
            and(
              eq(listingSlugRedirects.oldSlug, oldSlug),
              sql`${listings.status} = 'approved'`,
              sql`${listings.isActive} = 1`,
              sql`${listings.publishedAt} IS NOT NULL`,
              sql`${listings.publishedAt} <= ${asOf}`
            )
          )
          .limit(1)
      )
      return rows[0]?.slug || null
    },
    async getCategoryBySlug(slug) {
      return (await getShellStats()).categories.find(category => category.slug === slug) || null
    },
    async getFeaturedListingCount() {
      return (await getShellStats()).featuredCount
    },
    async getFeaturedListings(limit = 6) {
      return publicationHead('featured-summaries', limit)
    },
    async getLatestListings(limit = 12) {
      return publicationHead('latest-summaries', limit)
    },
    getListingBySlug,
    getListingNamePage,
    getPublicationVersion,
    getPublishedListings,
    getShellStats,
    getSitemapListings: getPublishedListings,
    getUnpublishedListing,
    searchListings
  }
}
