import 'server-only'

import { and, eq, type SQL, sql } from 'drizzle-orm'
import { type CompiledSiteQuery, runSiteQuery } from './client'
import type {
  CatalogCacheEvent,
  CatalogOperation,
  CatalogOperations,
  CatalogOperationsConfig,
  CatalogQueryEvent,
  CatalogQueryShape,
  CatalogShellStats,
  ListingDetail,
  ListingNavigation,
  ListingPage,
  ListingResourceLink,
  ListingSummary,
  PublishedCategory,
  RelatedListing
} from './contracts'
import { listingSlugRedirects, listings, publicationState } from './schema'

const CACHE_SCHEMA = 'v2'
const CACHE_TTL_SECONDS = 60 * 60
const PUBLICATION_ORDER = 'l.published_at DESC, l.display_order ASC, l.slug ASC'
const runtimePriorities = new Set(['high', 'medium', 'low'])

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
  priority: string | null
  resource_links: string
  video: string | null
}

interface NavigationRow {
  logo: string | null
  name: string
  slug: string
  website: string
}

interface RelatedLogoRow {
  listing_id: string
  url: string
}

interface ShellRow {
  categories: string
  featured_count: number
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
  return `${alias}.site_id = ? AND ${alias}.status = 'approved' AND ${alias}.is_active = 1 AND ${alias}.published_at IS NOT NULL AND ${alias}.published_at <= ?`
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
    WHERE lc.listing_id = l.id AND lc.is_primary = 1 AND c.site_id = l.site_id AND c.is_active = 1
    LIMIT 1
  ) AS category,
  (
    SELECT group_concat(ordered.slug, char(31))
    FROM (
      SELECT c.slug
      FROM listing_categories lc
      JOIN categories c ON c.id = lc.category_id
      WHERE lc.listing_id = l.id AND c.site_id = l.site_id AND c.is_active = 1
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

  return {
    ...summary,
    content: row.content || undefined,
    entityType: row.entity_type || undefined,
    media:
      logo || video || images.length
        ? {
            logo,
            images: images.length ? images : undefined,
            video
          }
        : undefined,
    priority,
    resourceLinks: resources.length ? resources : undefined
  }
}

function isShellStats(value: unknown, publicationVersion: number): value is CatalogShellStats {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CatalogShellStats>
  return (
    candidate.publicationVersion === publicationVersion &&
    Number.isSafeInteger(candidate.featuredCount) &&
    (candidate.featuredCount as number) >= 0 &&
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

export function createCatalogOperations(config: CatalogOperationsConfig): CatalogOperations {
  const { cache, client, clock, observe } = config
  const { siteId } = client
  let publicationVersionPromise: Promise<number> | undefined
  let publishedListingsPromise: Promise<ListingSummary[]> | undefined
  let shellStatsPromise: Promise<CatalogShellStats> | undefined
  const detailPromises = new Map<string, Promise<ListingDetail | null>>()

  async function queryAll<T>(
    operation: CatalogOperation,
    queryShape: CatalogQueryShape,
    statement: CompiledSiteQuery | SQL<T>
  ): Promise<T[]> {
    const startedAt = performance.now()
    let eventEmitted = false
    try {
      const result = await runSiteQuery<T>(client, statement)
      const meta = result.meta as QueryMeta
      const event: CatalogQueryEvent = {
        d1DurationMs: finiteMetric(meta?.duration),
        event: 'd1_query',
        operation,
        queryShape,
        resultRows: result.results.length,
        rowsRead: finiteMetric(meta?.rows_read),
        rowsWritten: finiteMetric(meta?.rows_written),
        siteId,
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
          event: 'd1_query',
          operation,
          queryShape,
          resultRows: 0,
          rowsRead: null,
          rowsWritten: null,
          siteId,
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
        observe({ event: 'catalog_cache', operation, siteId, state: 'miss' })
        return null
      }
      if (validate(cached)) {
        observe({ event: 'catalog_cache', operation, siteId, state: 'hit' })
        return cached
      }
      observe({ event: 'catalog_cache', operation, siteId, state: 'corrupt' })
    } catch {
      observe({ event: 'catalog_cache', operation, siteId, state: 'error' })
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
      observe({ event: 'catalog_cache', operation, siteId, state: 'written' })
    } catch {
      observe({ event: 'catalog_cache', operation, siteId, state: 'write-error' })
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
          siteId,
          asOf,
          ...extraBindings,
          ...(limit === undefined ? [] : [limit]),
          ...(offset === undefined ? [] : [offset])
        ]
      )
    )
    return rows.map(mapSummary)
  }

  async function queryPublicationVersion(): Promise<number> {
    const rows = await queryAll<{ version: number }>(
      'publication-version',
      'publication-version',
      client.database
        .select({ version: publicationState.version })
        .from(publicationState)
        .where(eq(publicationState.siteId, siteId))
        .limit(1)
    )
    return requireNonNegativeInteger(rows[0]?.version, `publication state for ${siteId}`)
  }

  function getPublicationVersion(): Promise<number> {
    publicationVersionPromise ||= queryPublicationVersion()
    return publicationVersionPromise
  }

  async function loadShellStats(): Promise<CatalogShellStats> {
    const publicationVersion = await getPublicationVersion()
    const cacheKey = `catalog-shell:${CACHE_SCHEMA}:${siteId}:${publicationVersion}`
    const cached = await readCache('shell-stats', cacheKey, (value): value is CatalogShellStats =>
      isShellStats(value, publicationVersion)
    )
    if (cached) return cached

    const asOf = operationTime()
    const rows = await queryAll<ShellRow>(
      'shell-stats',
      'shell-stats',
      parameterizedQuery<ShellRow>(
        `SELECT
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
              (
                SELECT COUNT(*)
                FROM listing_categories lc
                JOIN listings l ON l.id = lc.listing_id
                WHERE lc.category_id = c.id AND ${publicEligibilitySql()}
              ) AS listing_count
            FROM categories c
            WHERE c.site_id = ? AND c.is_active = 1
            ORDER BY c.sort_order ASC, c.name ASC
          ) counts
        ), '[]') AS categories,
        (
          SELECT COUNT(*)
          FROM listings l
          WHERE ${publicEligibilitySql()} AND l.is_featured = 1
        ) AS featured_count`,
        [siteId, asOf, siteId, siteId, asOf]
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
      publicationVersion
    }
    await writeCache('shell-stats', cacheKey, stats)
    return stats
  }

  function getShellStats(): Promise<CatalogShellStats> {
    shellStatsPromise ||= loadShellStats()
    return shellStatsPromise
  }

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
            predicate: 'l.published_at = ? AND l.display_order = ? AND l.slug < ?',
            shape: 'navigation-previous-slug' as const
          },
          {
            bindings: [current.published_at, current.display_order],
            order: 'l.display_order DESC, l.slug DESC',
            predicate: 'l.published_at = ? AND l.display_order < ?',
            shape: 'navigation-previous-display' as const
          },
          {
            bindings: [current.published_at],
            order: 'l.published_at ASC, l.display_order DESC, l.slug DESC',
            predicate: 'l.published_at > ?',
            shape: 'navigation-previous-publication' as const
          }
        ]
      : [
          {
            bindings: [current.published_at, current.display_order, current.slug],
            order: 'l.slug ASC',
            predicate: 'l.published_at = ? AND l.display_order = ? AND l.slug > ?',
            shape: 'navigation-next-slug' as const
          },
          {
            bindings: [current.published_at, current.display_order],
            order: 'l.display_order ASC, l.slug ASC',
            predicate: 'l.published_at = ? AND l.display_order > ?',
            shape: 'navigation-next-display' as const
          },
          {
            bindings: [current.published_at],
            order: PUBLICATION_ORDER,
            predicate: 'l.published_at < ?',
            shape: 'navigation-next-publication' as const
          }
        ]

    for (const branch of branches) {
      const rows = await queryAll<NavigationRow>(
        'listing-detail',
        branch.shape,
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
      WHERE ${publicEligibilitySql()} AND ${branch.predicate}
      ORDER BY ${branch.order}
      LIMIT 1`,
          [siteId, asOf, ...branch.bindings]
        )
      )
      if (rows[0]) return mapNavigation(rows[0])
    }
    return null
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
        [siteId, asOf, slug]
      )
    )
    const row = rows[0]
    if (!row) return null

    const relatedRows: SummaryRow[] = []
    const sharedCategoryCount = (row.categories || '')
      .split(String.fromCharCode(31))
      .filter(Boolean).length
    if (sharedCategoryCount === 1) {
      relatedRows.push(
        ...(await queryAll<SummaryRow>(
          'listing-detail',
          'related-single-category',
          parameterizedQuery<SummaryRow>(
            `SELECT
             l.id,
             l.slug,
             l.name,
             l.description,
             l.website,
             l.display_order,
             l.is_unofficial,
             l.is_featured,
             l.published_at,
             '' AS category,
             NULL AS categories,
             NULL AS logo
           FROM listings l INDEXED BY listings_related_name_idx
           WHERE ${publicEligibilitySql()}
             AND l.id != ?
             AND EXISTS (
               SELECT 1
               FROM listing_categories shared
               WHERE shared.listing_id = l.id
                 AND shared.category_id = (
                   SELECT current.category_id
                   FROM listing_categories current
                   WHERE current.listing_id = ?
                   LIMIT 1
                 )
             )
           ORDER BY l.name ASC, l.slug ASC
           LIMIT 4`,
            [siteId, asOf, row.id, row.id]
          )
        ))
      )
    }
    for (
      let score = sharedCategoryCount;
      sharedCategoryCount > 1 && score >= 1 && relatedRows.length < 4;
      score -= 1
    ) {
      const scoreRows = await queryAll<SummaryRow>(
        'listing-detail',
        'related-ranked-seek',
        parameterizedQuery<SummaryRow>(
          `SELECT
           l.id,
           l.slug,
           l.name,
           l.description,
           l.website,
           l.display_order,
           l.is_unofficial,
           l.is_featured,
           l.published_at,
           '' AS category,
           NULL AS categories,
           NULL AS logo
         FROM listings l INDEXED BY listings_related_name_idx
         WHERE ${publicEligibilitySql()}
           AND l.id != ?
           AND (
             SELECT COUNT(*)
             FROM listing_categories current
             WHERE current.listing_id = ?
               AND EXISTS (
                 SELECT 1
                 FROM listing_categories shared
                 WHERE shared.listing_id = l.id
                   AND shared.category_id = current.category_id
               )
           ) = ?
         ORDER BY l.name ASC, l.slug ASC
         LIMIT ?`,
          [siteId, asOf, row.id, row.id, score, 4 - relatedRows.length]
        )
      )
      relatedRows.push(...scoreRows)
    }
    const relatedIds = relatedRows.map(related => related.id)
    const logoRows = relatedIds.length
      ? await queryAll<RelatedLogoRow>(
          'listing-detail',
          'related-logos',
          parameterizedQuery<RelatedLogoRow>(
            `SELECT listing_id, url
           FROM listing_media
           WHERE listing_id IN (${relatedIds.map(() => '?').join(', ')})
             AND kind = 'logo'
           ORDER BY listing_id ASC, sort_order ASC`,
            relatedIds
          )
        )
      : []
    const logos = new Map<string, string>()
    for (const logo of logoRows) {
      if (!logos.has(logo.listing_id)) logos.set(logo.listing_id, logo.url)
    }
    const relatedWebsites: RelatedListing[] = relatedRows.map(related => ({
      description: requireString(related.description, 'related description'),
      isUnofficial: related.is_unofficial === 1 || undefined,
      media: logos.has(related.id)
        ? { logo: requireString(logos.get(related.id), 'related logo') }
        : undefined,
      name: requireString(related.name, 'related name'),
      slug: requireString(related.slug, 'related slug'),
      website: requireString(related.website, 'related website')
    }))
    const [previousWebsite, nextWebsite] = await Promise.all([
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

  async function loadListingBySlug(slug: string): Promise<ListingDetail | null> {
    const publicationVersion = await getPublicationVersion()
    const cacheKey = `catalog-detail:${CACHE_SCHEMA}:${siteId}:${publicationVersion}:${slug}`
    const cached = await readCache('listing-detail', cacheKey, (value): value is DetailCacheEntry =>
      isDetailCacheEntry(value, publicationVersion)
    )
    if (cached) return cached.detail

    const detail = await queryListingBySlug(slug)
    await writeCache('listing-detail', cacheKey, { detail, publicationVersion })
    return detail
  }

  function getListingBySlug(slug: string): Promise<ListingDetail | null> {
    const existing = detailPromises.get(slug)
    if (existing) return existing
    const detail = loadListingBySlug(slug)
    detailPromises.set(slug, detail)
    return detail
  }

  async function loadPublishedListings(): Promise<ListingSummary[]> {
    const publicationVersion = await getPublicationVersion()
    const cacheKey = `catalog-published:${CACHE_SCHEMA}:${siteId}:${publicationVersion}`
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

  async function getPublishedListingPage(page = 1, pageSize = 48): Promise<ListingPage> {
    const safePage = Math.max(1, Math.trunc(page))
    const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)))
    const asOf = operationTime()
    const [rows, countRows] = await Promise.all([
      queryAll<SummaryRow>(
        'listing-page',
        'listing-page-items',
        parameterizedQuery<SummaryRow>(
          `SELECT ${summaryColumns} FROM listings l WHERE ${publicEligibilitySql()} ORDER BY ${PUBLICATION_ORDER} LIMIT ? OFFSET ?`,
          [siteId, asOf, safePageSize, (safePage - 1) * safePageSize]
        )
      ),
      queryAll<{ total: number }>(
        'listing-page',
        'listing-page-count',
        parameterizedQuery<{ total: number }>(
          `SELECT COUNT(*) AS total FROM listings l WHERE ${publicEligibilitySql()}`,
          [siteId, asOf]
        )
      )
    ])
    return {
      items: rows.map(mapSummary),
      page: safePage,
      pageSize: safePageSize,
      total: requireNonNegativeInteger(countRows[0]?.total, 'listing count')
    }
  }

  async function searchListings(query: string, limit = 50): Promise<ListingSummary[]> {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return []
    const terms = normalized.split(/\s+/u).filter(Boolean)
    const patterns = terms.map(
      term => `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    )
    const termClause = `(lower(l.name) LIKE ? ESCAPE '\\' OR lower(l.description) LIKE ? ESCAPE '\\' OR lower(l.website) LIKE ? ESCAPE '\\' OR lower(l.slug) LIKE ? ESCAPE '\\' OR lower(COALESCE(l.content, '')) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id = l.id AND (lower(c.slug) LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\')))`
    const escaped = normalized
      .replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%')
      .replaceAll('_', '\\_')
    return summaries(
      'search-summaries',
      'search-summaries',
      ` AND ${terms.map(() => termClause).join(' AND ')}`,
      [
        ...patterns.flatMap(pattern => Array(7).fill(pattern)),
        normalized,
        `${escaped}%`,
        `%${escaped}%`
      ],
      `CASE WHEN lower(l.name) = ? THEN 0 WHEN lower(l.name) LIKE ? ESCAPE '\\' THEN 1 WHEN lower(l.name) LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END, l.name ASC, l.slug ASC`,
      Math.min(1000, Math.max(1, Math.trunc(limit)))
    )
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
              eq(listingSlugRedirects.siteId, siteId),
              eq(listingSlugRedirects.oldSlug, oldSlug),
              sql`${listings.siteId} = ${siteId}`,
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
      const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)))
      return (await getPublishedListings()).filter(listing => listing.featured).slice(0, safeLimit)
    },
    async getLatestListings(limit = 12) {
      const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)))
      return (await getPublishedListings()).slice(0, safeLimit)
    },
    getListingBySlug,
    async getListingsByCategory(slug) {
      return (await getPublishedListings()).filter(listing => listing.categories?.includes(slug))
    },
    getPublicationVersion,
    getPublishedListingPage,
    getPublishedListings,
    getShellStats,
    getSitemapListings: getPublishedListings,
    searchListings
  }
}
