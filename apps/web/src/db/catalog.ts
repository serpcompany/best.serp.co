import 'server-only'

import { and, eq, type SQL, sql } from 'drizzle-orm'
import {
  type CatalogEpoch,
  catalogEpochStatement,
  catalogEpochToken,
  LISTING_IN_RETIRED_CATEGORY_SQL,
  parseCatalogEpoch,
  parseTaxonomyTarget,
  TAXONOMY_TARGET_JOINS,
  TAXONOMY_TARGET_SLUG
} from './catalog-epoch'
import { type CompiledQuery, d1ErrorCode, runQuery } from './client'
import type {
  BestPageItem,
  CatalogCacheEvent,
  CatalogDerivation,
  CatalogOperation,
  CatalogOperations,
  CatalogOperationsConfig,
  CatalogQueryEvent,
  CatalogQueryShape,
  CatalogShellStats,
  ListingDetail,
  ListingFaq,
  ListingLinkRel,
  ListingNamePage,
  ListingNamePageQuery,
  ListingNavigation,
  ListingResourceLink,
  ListingSummary,
  ListingTag,
  PublishedBestPage,
  PublishedCategory,
  PublishedTag,
  RelatedListing,
  TaxonomyKind,
  TaxonomyTarget,
  UnpublishedListing
} from './contracts'
import { latestInstant } from './instants'
import { listingSlugRedirects, listings } from './schema'

/**
 * v8: listing details carry `tags`, name pages `tag`, and name-order and name-page keys name
 * their scope (`*`, `c:<category>`, `t:<tag>`), so a tag and a category with one slug never
 * share an entry (#345); v7: listing summaries carry `modifiedAt`, and directory pages
 * `lastModifiedAt` (#218); v6: listing details carry `faqs` (#105); v5: a hosted logo or image is
 * its media key (#95), which the web adapter turns into a URL on the environment's media host; v4
 * added `linkRel` and `verifiedOwner` (#62).
 */
const CACHE_SCHEMA = 'v8'
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
/**
 * A single-category listing's related candidates are read from its category's members
 * when the category is at most this large; larger (dense) categories walk the name index
 * instead, which finds four members after a handful of rows. Both plans return the same
 * rows; this only picks the cheaper one (see `relatedListings`).
 */
const RELATED_MEMBER_SCAN_LIMIT = 128
/**
 * How many of a tagged listing's active tags score its related listings: the most central
 * (`listing_tags.sort_order`, then slug, the order its page lists them in), so the statement reads
 * the members of at most this many tags however many the listing has (#362 review).
 */
const RELATED_SCORED_TAGS = 3
/**
 * How many of a best-page entry's active tags it carries for its chips (#341, design 5.1): the
 * most central, so hydrating an entry reads at most this many tags however many it has.
 */
const BEST_ITEM_TAGS = 3
/**
 * `strftime` with this format reads both D1 time formats and writes the ISO instant `toInstant`
 * writes, so `MAX()` over it orders a column whose rows mix the two.
 */
const ISO_INSTANT = "'%Y-%m-%dT%H:%M:%fZ'"
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
  updated_at: string | null
  website: string
}

interface DetailRow extends SummaryRow {
  content: string | null
  entity_type: string | null
  images: string
  link_rel: string
  faqs: string
  priority: string | null
  resource_links: string
  tags: string
  verified_owner: number
  video: string | null
}

interface TagStatsRow {
  tags: string
}

interface BestIndexRow {
  category: string | null
  excluded_in_tag: number
  heading: string
  hub: string | null
  intro: string
  keyword: string
  list_size: number
  pins_outside: number
  pins_published: string | null
  pins_updated: string | null
  scanned_count: number | null
  scanned_published: string | null
  scanned_updated: string | null
  slug: string
  sort_order: number
  tag: string | null
  title: string
  updated_at: string
}

interface BestItemRow extends SummaryRow {
  blurb: string | null
  link_rel: string
  tags: string
}

interface TaxonomyRedirectRow {
  kind: string
  slug: string | null
}

interface UnpublishedRow {
  category: string | null
  category_name: string | null
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
  updated_at: string | null
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

/** Published and active, at any publication time (no `asOf` binding). */
function publishedSql(alias = 'l'): string {
  return `${alias}.status = 'approved' AND ${alias}.is_active = 1 AND ${alias}.published_at IS NOT NULL`
}

function publicEligibilitySql(alias = 'l'): string {
  return `${publishedSql(alias)} AND ${alias}.published_at <= ?`
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
  l.updated_at,
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
    SELECT COALESCE(m.media_key, m.url)
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
  const modifiedAt = latestInstant(row.published_at, row.updated_at)
  if (!modifiedAt) throw new Error(`Invalid D1 listing ${row.slug}: publication date.`)
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
    modifiedAt,
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

function mapListingTags(value: string): ListingTag[] {
  return parseJsonArray(value, 'listing tags').map((tag, index) => {
    if (!tag || typeof tag !== 'object') throw new Error(`Invalid D1 tag ${index + 1}.`)
    const candidate = tag as Record<string, unknown>
    return {
      name: requireString(candidate.name, `tag ${index + 1} name`),
      slug: requireString(candidate.slug, `tag ${index + 1} slug`)
    }
  })
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
  const faqs: ListingFaq[] = parseJsonArray(row.faqs, 'listing FAQs').map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid D1 FAQ ${index + 1}.`)
    const faq = value as Record<string, unknown>
    return {
      answer: requireString(faq.answer, `FAQ ${index + 1} answer`),
      question: requireString(faq.question, `FAQ ${index + 1} question`)
    }
  })
  const priority =
    typeof row.priority === 'string' && runtimePriorities.has(row.priority)
      ? (row.priority as 'high' | 'low' | 'medium')
      : undefined
  const logo = summary.media?.logo
  const video = row.video || undefined
  const tags = mapListingTags(row.tags)
  if (!runtimeLinkRels.has(row.link_rel))
    throw new Error(`Invalid D1 listing ${row.slug} link rel.`)

  return {
    ...summary,
    content: row.content || undefined,
    entityType: row.entity_type || undefined,
    faqs: faqs.length ? faqs : undefined,
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
    tags: tags.length ? tags : undefined,
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
    typeof candidate.modifiedAt === 'string' &&
    candidate.modifiedAt.length > 0 &&
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
    (candidate.faqs === undefined ||
      (Array.isArray(candidate.faqs) &&
        candidate.faqs.every(
          faq =>
            faq &&
            typeof faq.question === 'string' &&
            faq.question.length > 0 &&
            typeof faq.answer === 'string' &&
            faq.answer.length > 0
        ))) &&
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
        ))) &&
    (candidate.tags === undefined ||
      (Array.isArray(candidate.tags) &&
        candidate.tags.length > 0 &&
        candidate.tags.every(
          tag =>
            tag &&
            typeof tag.name === 'string' &&
            tag.name.length > 0 &&
            typeof tag.slug === 'string' &&
            tag.slug.length > 0
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

interface DerivedCacheEntry<T> {
  publicationVersion: number
  value: T
}

function isDerivedCacheEntry<T>(
  value: unknown,
  publicationVersion: number,
  validate: (value: unknown) => value is T
): value is DerivedCacheEntry<T> {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DerivedCacheEntry<T>>
  return candidate.publicationVersion === publicationVersion && validate(candidate.value)
}

interface NameOrderEntry {
  firstPublishedAt: string | null
  ids: string[]
  lastModifiedAt: string | null
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
    isNullableString(candidate.lastModifiedAt) &&
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
    (page.tag === null || (typeof page.tag === 'string' && page.tag.length > 0)) &&
    (page.category === null || page.tag === null) &&
    isNullableString(page.firstPublishedAt) &&
    isNullableString(page.lastModifiedAt) &&
    isNullableString(page.lastPublishedAt) &&
    Array.isArray(page.items) &&
    page.items.every(isListingSummary) &&
    [page.page, page.pageCount, page.pageSize, page.total].every(
      value => Number.isSafeInteger(value) && (value as number) >= 0
    )
  )
}

interface TagStatsEntry {
  publicationVersion: number
  tags: PublishedTag[]
}

interface BestIndexEntry {
  pages: PublishedBestPage[]
  publicationVersion: number
}

interface BestItemsEntry {
  items: BestPageItem[]
  publicationVersion: number
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPublishedTag(value: unknown): value is PublishedTag {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PublishedTag>
  return (
    isNonEmptyString(candidate.category) &&
    isNonNegativeInteger(candidate.count) &&
    typeof candidate.description === 'string' &&
    isNullableString(candidate.lastModifiedAt) &&
    isNonEmptyString(candidate.name) &&
    isNonNegativeInteger(candidate.order) &&
    isNonEmptyString(candidate.slug)
  )
}

function isTagStatsEntry(value: unknown, publicationVersion: number): value is TagStatsEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TagStatsEntry>
  return (
    candidate.publicationVersion === publicationVersion &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every(isPublishedTag)
  )
}

function isPublishedBestPage(value: unknown): value is PublishedBestPage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PublishedBestPage>
  return (
    (candidate.category === null || isNonEmptyString(candidate.category)) &&
    isNonEmptyString(candidate.heading) &&
    isNonEmptyString(candidate.hub) &&
    typeof candidate.intro === 'string' &&
    isNonEmptyString(candidate.keyword) &&
    isNonEmptyString(candidate.lastModifiedAt) &&
    isNonNegativeInteger(candidate.listSize) &&
    isNonNegativeInteger(candidate.order) &&
    isNonNegativeInteger(candidate.poolSize) &&
    isNonEmptyString(candidate.slug) &&
    (candidate.tag === null || isNonEmptyString(candidate.tag)) &&
    (candidate.tag !== null || candidate.category !== null) &&
    isNonEmptyString(candidate.title)
  )
}

function isBestIndexEntry(value: unknown, publicationVersion: number): value is BestIndexEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BestIndexEntry>
  return (
    candidate.publicationVersion === publicationVersion &&
    Array.isArray(candidate.pages) &&
    candidate.pages.every(isPublishedBestPage)
  )
}

function isBestPageItem(value: unknown): value is BestPageItem {
  if (!isListingSummary(value)) return false
  const candidate = value as BestPageItem
  return (
    (candidate.blurb === undefined || isNonEmptyString(candidate.blurb)) &&
    runtimeLinkRels.has(candidate.linkRel) &&
    // Required, so an entry cached before it carried its tags is read again.
    Array.isArray(candidate.tags) &&
    candidate.tags.length <= BEST_ITEM_TAGS &&
    candidate.tags.every(tag => tag && isNonEmptyString(tag.name) && isNonEmptyString(tag.slug))
  )
}

function isBestItemsEntry(value: unknown, publicationVersion: number): value is BestItemsEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BestItemsEntry>
  return (
    candidate.publicationVersion === publicationVersion &&
    Array.isArray(candidate.items) &&
    candidate.items.every(isBestPageItem)
  )
}

/** Which listings a name order holds: the whole directory, one category, or one tag (#341). */
type NameOrderScope =
  | { kind: 'all' }
  | { kind: 'category'; slug: string }
  | { kind: 'tag'; slug: string }

/** The scope's part of a name-order or name-page cache key: `*`, `c:<slug>` or `t:<slug>`. */
function nameOrderScopeKey(scope: NameOrderScope): string {
  if (scope.kind === 'all') return '*'
  return `${scope.kind === 'category' ? 'c' : 't'}:${scope.slug}`
}

/**
 * The candidates of a tagged listing's related listings (#341 design 3.2, #362 review), in one
 * statement:
 *
 * - `tagged`: the listings sharing its `RELATED_SCORED_TAGS` most central active tags, scored by
 *   how many they share, ties broken on a keyset from its own name and slug (the names after it
 *   first, then from the start), at most four.
 * - When `tagged` has fewer than four, its hub (primary category) fills the rest with score 0 and
 *   the same keyset: through the hub's members when the hub has at most
 *   `RELATED_MEMBER_SCAN_LIMIT` memberships, else by walking the public name index from its own
 *   name and then from the start, as an untagged listing in one category does. `fill.plan` picks
 *   the branch, and the others' `LIMIT` is 0, which SQLite checks before reading a row; no branch
 *   reads anything once `tagged` has four. Each returns at most four rows, which always covers
 *   the gap: at most as many of them repeat `tagged` as `tagged` has, which leaves at least as
 *   many new ones as it lacks.
 */
function relatedByTags(
  row: { id: string; name: string; slug: string },
  asOf: string
): { bindings: unknown[]; candidates: string } {
  const columns = 'l.id, l.slug, l.name, l.description, l.website, l.is_unofficial, 0 AS score'
  const limit = (plan: 'members' | 'walk') =>
    `CASE WHEN (SELECT plan FROM fill) = '${plan}' THEN 4 ELSE 0 END`
  const walk = (comparison: '<' | '>', wrap: 0 | 1) => `SELECT * FROM (
         SELECT ${columns}, ${wrap} AS wrap
         FROM listings l INDEXED BY listings_related_name_idx
         WHERE ${publicEligibilitySql()}
           AND (l.name, l.slug) ${comparison} (?, ?)
           AND EXISTS (
             SELECT 1 FROM listing_categories member
             WHERE member.listing_id = l.id AND member.category_id = (SELECT id FROM fill)
           )
         ORDER BY l.name ASC, l.slug ASC
         LIMIT ${limit('walk')}
       )`
  return {
    bindings: [
      row.id,
      row.name,
      row.slug,
      row.id,
      asOf,
      row.id,
      row.name,
      row.slug,
      asOf,
      row.id,
      asOf,
      row.name,
      row.slug,
      asOf,
      row.name,
      row.slug
    ],
    candidates: `WITH current_tags AS (
         SELECT lt.tag_id
         FROM listing_tags lt
         CROSS JOIN tags t ON t.id = lt.tag_id
         WHERE lt.listing_id = ? AND t.is_active = 1
         ORDER BY lt.sort_order ASC, t.slug ASC
         LIMIT ${RELATED_SCORED_TAGS}
       ),
       tagged AS (
         SELECT l.id, l.slug, l.name, l.description, l.website, l.is_unofficial,
           COUNT(*) AS score,
           CASE WHEN (l.name, l.slug) > (?, ?) THEN 0 ELSE 1 END AS wrap
         FROM current_tags current
         CROSS JOIN listing_tags shared INDEXED BY listing_tags_tag_idx
           ON shared.tag_id = current.tag_id
         CROSS JOIN listings l ON l.id = shared.listing_id
         WHERE shared.listing_id != ? AND ${publicEligibilitySql()}
         GROUP BY l.id
         ORDER BY score DESC, wrap ASC, l.name ASC, l.slug ASC
         LIMIT 4
       ),
       fill AS (
         SELECT hub.category_id AS id,
           CASE
             WHEN (SELECT COUNT(*) FROM tagged) >= 4 THEN 'none'
             WHEN NOT EXISTS (
               SELECT 1 FROM listing_categories sized INDEXED BY listing_categories_category_idx
               WHERE sized.category_id = hub.category_id
               LIMIT 1 OFFSET ${RELATED_MEMBER_SCAN_LIMIT}
             ) THEN 'members'
             ELSE 'walk'
           END AS plan
         FROM listing_categories hub
         WHERE hub.listing_id = ? AND hub.is_primary = 1
         LIMIT 1
       )
       SELECT id, slug, name, description, website, is_unofficial,
         MAX(score) AS score, MIN(wrap) AS wrap
       FROM (
         SELECT * FROM tagged
         UNION ALL
         SELECT * FROM (
           SELECT ${columns},
             CASE WHEN (l.name, l.slug) > (?, ?) THEN 0 ELSE 1 END AS wrap
           FROM listing_categories member INDEXED BY listing_categories_category_idx
           CROSS JOIN listings l ON l.id = member.listing_id
           WHERE member.category_id = (SELECT id FROM fill)
             AND ${publicEligibilitySql()}
             AND l.id != ?
           ORDER BY wrap ASC, l.name ASC, l.slug ASC
           LIMIT ${limit('members')}
         )
         UNION ALL
         ${walk('>', 0)}
         UNION ALL
         ${walk('<', 1)}
       )
       GROUP BY id
       ORDER BY score DESC, wrap ASC, name ASC, slug ASC
       LIMIT 4`
  }
}

export function createCatalogOperations(config: CatalogOperationsConfig): CatalogOperations {
  const { cache, client, clock, observe } = config
  let epochPromise: Promise<CatalogEpoch> | undefined
  let publishedListingsPromise: Promise<ListingSummary[]> | undefined
  let shellStatsPromise: Promise<CatalogShellStats> | undefined
  let tagStatsPromise: Promise<PublishedTag[]> | undefined
  let bestIndexPromise: Promise<PublishedBestPage[]> | undefined
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
            asOfBound: true,
            bindings: [current.published_at, current.display_order, current.slug],
            order: 'l.slug DESC',
            predicate: 'l.published_at = ? AND l.display_order = ? AND l.slug < ?'
          },
          {
            asOfBound: true,
            bindings: [current.published_at, current.display_order],
            order: 'l.display_order DESC, l.slug DESC',
            predicate: 'l.published_at = ? AND l.display_order < ?'
          },
          {
            asOfBound: true,
            bindings: [current.published_at],
            order: 'l.published_at ASC, l.display_order DESC, l.slug DESC',
            predicate: 'l.published_at > ?'
          }
        ]
      : [
          {
            asOfBound: true,
            bindings: [current.published_at, current.display_order, current.slug],
            order: 'l.slug ASC',
            predicate: 'l.published_at = ? AND l.display_order = ? AND l.slug > ?'
          },
          {
            asOfBound: true,
            bindings: [current.published_at, current.display_order],
            order: 'l.display_order ASC, l.slug ASC',
            predicate: 'l.published_at = ? AND l.display_order > ?'
          },
          {
            // Published before the current listing, which is public at `asOf`, so already
            // public too. A second upper bound (`<= asOf`) would let SQLite seek on that one
            // and walk every newer listing first: 3,425 rows for the oldest listing (#314).
            asOfBound: false,
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
          SELECT COALESCE(m.media_key, m.url) FROM listing_media m
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
          WHERE ${branch.asOfBound ? publicEligibilitySql() : publishedSql()} AND ${branch.predicate}
          ORDER BY ${branch.order}
          LIMIT 1
        )`
          )
          .join(',\n        ')}
      )
      LIMIT 1`,
        branches.flatMap(branch => [...(branch.asOfBound ? [asOf] : []), ...branch.bindings])
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
            SELECT COALESCE(m.media_key, m.url) AS url FROM listing_media m
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
        ), '[]') AS resource_links,
        COALESCE((
          SELECT json_group_array(json_object('question', ordered.question, 'answer', ordered.answer))
          FROM (
            SELECT f.question, f.answer FROM listing_faqs f
            WHERE f.listing_id = l.id
            ORDER BY f.sort_order ASC
          ) ordered
        ), '[]') AS faqs,
        COALESCE((
          SELECT json_group_array(json_object('slug', ordered.slug, 'name', ordered.name))
          FROM (
            SELECT t.slug, t.name FROM listing_tags lt
            JOIN tags t ON t.id = lt.tag_id
            WHERE lt.listing_id = l.id AND t.is_active = 1
            ORDER BY lt.sort_order ASC, t.slug ASC
          ) ordered
        ), '[]') AS tags
      FROM listings l
      WHERE ${publicEligibilitySql()} AND l.slug = ?
      LIMIT 1`,
        [asOf, slug]
      )
    )
    const row = rows[0]
    if (!row) return null

    const detail = mapDetail(row)
    const [relatedWebsites, previousWebsite, nextWebsite] = await Promise.all([
      relatedListings(row, asOf, detail.tags ?? []),
      navigation(row, asOf, 'previous'),
      navigation(row, asOf, 'next')
    ])
    return {
      ...detail,
      nextWebsite,
      previousWebsite,
      relatedWebsites
    }
  }

  /**
   * Up to four related listings. One statement, with each related logo resolved only for the
   * returned rows.
   *
   * - Tags (#341, design 3.2): ranked by shared active tags (most first), counted from the
   *   listing's three most central tags (`RELATED_SCORED_TAGS`, bounded by the size of those
   *   tags). Ties break on a keyset from the listing's own name and slug: the listings after it in
   *   name order first, wrapping round to the start, so listings that share the same tags link
   *   onward to different neighbours instead of all linking to the first names (#331). When the
   *   tags yield fewer than four, the rest come from its hub in the same statement, with the same
   *   keyset (`relatedByTags`).
   * - No tags: ranked by shared categories (most first), then name and slug.
   *   - Several categories: count shared memberships from the listing's own categories
   *     (bounded by the size of those categories).
   *   - One category: read that category's members when it is small, otherwise walk the
   *     public name index, where a dense category yields four members almost immediately.
   */
  async function relatedListings(
    row: DetailRow,
    asOf: string,
    tags: ListingTag[]
  ): Promise<RelatedListing[]> {
    const sharedCategoryCount = (row.categories || '')
      .split(String.fromCharCode(31))
      .filter(Boolean).length
    let queryShape: CatalogQueryShape
    let candidates: string
    let bindings: unknown[]
    let tieBreak = ''
    if (tags.length > 0) {
      queryShape = 'related-shared-tags'
      tieBreak = 'related.wrap ASC, '
      const statement = relatedByTags(row, asOf)
      candidates = statement.candidates
      bindings = statement.bindings
    } else if (sharedCategoryCount > 1) {
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
          SELECT COALESCE(m.media_key, m.url) FROM listing_media m
          WHERE m.listing_id = related.id AND m.kind = 'logo'
          ORDER BY m.sort_order ASC LIMIT 1
        ) AS logo
      FROM (
        ${candidates}
      ) related
      ORDER BY related.score DESC, ${tieBreak}related.name ASC, related.slug ASC`,
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
   * A value derived from this epoch's public data (`CatalogDerivation`): read from the data
   * cache when this epoch already has it, otherwise computed and written there (#334). Reads no
   * D1 rows itself.
   */
  async function getDerivedValue<T>(derivation: CatalogDerivation<T>): Promise<T> {
    const { key, publicationVersion } = await epochKey(`catalog-${derivation.kind}`)
    const cacheKey = `${key}:${derivation.format}:${derivation.id}`
    const cached = await readCache(
      derivation.kind,
      cacheKey,
      (value): value is DerivedCacheEntry<T> =>
        isDerivedCacheEntry(value, publicationVersion, derivation.validate)
    )
    if (cached) return cached.value

    const value = await derivation.compute()
    await writeCache(derivation.kind, cacheKey, { publicationVersion, value })
    return value
  }

  /**
   * One index seek on the unique slug. Uncached: it only runs after a detail lookup missed,
   * and an unpublished listing has no public epoch-keyed content to share. A listing filed under
   * a retired category is not found (#260), as in `isUnpublishedListingSlug`.
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
        ) AS category,
        (
          SELECT c.name
          FROM listing_categories lc
          JOIN categories c ON c.id = lc.category_id
          WHERE lc.listing_id = l.id AND lc.is_primary = 1 AND c.is_active = 1
          LIMIT 1
        ) AS category_name
      FROM listings l
      WHERE l.slug = ? AND l.status = 'approved' AND l.is_active = 0
        AND l.published_at IS NOT NULL
        AND NOT ${LISTING_IN_RETIRED_CATEGORY_SQL}
      LIMIT 1`,
        [slug]
      )
    )
    const row = rows[0]
    if (!row) return null
    return {
      category: row.category ? requireString(row.category, 'unpublished listing category') : null,
      categoryName: row.category_name
        ? requireString(row.category_name, 'unpublished listing category name')
        : null,
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
   * Public listing ids in directory name order: the whole directory, one category, or one tag
   * (#341). The order is the one the directory pages have always rendered: publication order,
   * then a stable locale sort by name. Only ids, names, and dates are read, and the result is
   * cached per epoch, so a page needs one small lookup instead of the whole catalog.
   */
  function getNameOrder(scope: NameOrderScope): Promise<NameOrderEntry> {
    const key = nameOrderScopeKey(scope)
    let order = nameOrderPromises.get(key)
    if (!order) {
      order = loadNameOrder(scope)
      nameOrderPromises.set(key, order)
    }
    return order
  }

  function nameOrderStatement(scope: NameOrderScope, asOf: string): SQL<NameOrderRow> {
    if (scope.kind === 'all') {
      return parameterizedQuery<NameOrderRow>(
        `SELECT l.id, l.name, l.published_at, l.updated_at
        FROM listings l
        WHERE ${publicEligibilitySql()}
        ORDER BY ${PUBLICATION_ORDER}`,
        [asOf]
      )
    }
    if (scope.kind === 'category') {
      return parameterizedQuery<NameOrderRow>(
        `SELECT l.id, l.name, l.published_at, l.updated_at
        FROM categories c
        CROSS JOIN listing_categories lc INDEXED BY listing_categories_category_idx
          ON lc.category_id = c.id
        CROSS JOIN listings l ON l.id = lc.listing_id
        WHERE c.slug = ? AND c.is_active = 1 AND ${publicEligibilitySql()}
        ORDER BY ${PUBLICATION_ORDER}`,
        [scope.slug, asOf]
      )
    }
    // An active tag's hub is active (the 0013 triggers), so the tag alone decides.
    return parameterizedQuery<NameOrderRow>(
      `SELECT l.id, l.name, l.published_at, l.updated_at
      FROM tags t
      CROSS JOIN listing_tags lt INDEXED BY listing_tags_tag_idx ON lt.tag_id = t.id
      CROSS JOIN listings l ON l.id = lt.listing_id
      WHERE t.slug = ? AND t.is_active = 1 AND ${publicEligibilitySql()}
      ORDER BY ${PUBLICATION_ORDER}`,
      [scope.slug, asOf]
    )
  }

  async function loadNameOrder(scope: NameOrderScope): Promise<NameOrderEntry> {
    const { key, publicationVersion } = await epochKey('catalog-name-order')
    const cacheKey = `${key}:${nameOrderScopeKey(scope)}`
    const cached = await readCache(
      'listing-name-order',
      cacheKey,
      (value): value is NameOrderEntry => isNameOrderEntry(value, publicationVersion)
    )
    if (cached) return cached

    const rows = await queryAll<NameOrderRow>(
      'listing-name-order',
      scope.kind === 'tag' ? 'tag-name-order' : 'listing-name-order',
      nameOrderStatement(scope, operationTime())
    )
    const ordered = rows
      .map(orderRow => ({
        id: requireString(orderRow.id, 'listing id'),
        modifiedAt: latestInstant(orderRow.published_at, orderRow.updated_at),
        name: requireString(orderRow.name, 'listing name'),
        publishedAt: requireString(orderRow.published_at, 'publication date').slice(0, 10)
      }))
      .sort((left, right) => nameCollator.compare(left.name, right.name))
    const dates = ordered.map(entry => entry.publishedAt).sort()
    const modified = ordered.flatMap(entry => (entry.modifiedAt ? [entry.modifiedAt] : [])).sort()
    const entry: NameOrderEntry = {
      firstPublishedAt: dates[0] ?? null,
      ids: ordered.map(orderEntry => orderEntry.id),
      lastModifiedAt: modified.at(-1) ?? null,
      lastPublishedAt: dates.at(-1) ?? null,
      publicationVersion
    }
    await writeCache('listing-name-order', cacheKey, entry)
    return entry
  }

  async function getListingNamePage(query: ListingNamePageQuery = {}): Promise<ListingNamePage> {
    if (query.category && query.tag) {
      throw new Error('A name page lists one category or one tag, not both.')
    }
    const scope: NameOrderScope = query.category
      ? { kind: 'category', slug: query.category }
      : query.tag
        ? { kind: 'tag', slug: query.tag }
        : { kind: 'all' }
    const page = Math.max(1, Math.trunc(query.page ?? 1))
    const pageSize = Math.min(
      MAX_LISTING_PAGE_SIZE,
      Math.max(1, Math.trunc(query.pageSize ?? LISTING_PAGE_SIZE))
    )
    const { key, publicationVersion } = await epochKey('catalog-name-page')
    const cacheKey = `${key}:${nameOrderScopeKey(scope)}:${pageSize}:${page}`
    const cached = await readCache('listing-name-page', cacheKey, (value): value is NamePageEntry =>
      isNamePageEntry(value, publicationVersion)
    )
    if (cached) return cached.page

    const order = await getNameOrder(scope)
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
      category: scope.kind === 'category' ? scope.slug : null,
      firstPublishedAt: order.firstPublishedAt,
      items: ids.flatMap(id => {
        const item = byId.get(id)
        return item ? [item] : []
      }),
      lastModifiedAt: order.lastModifiedAt,
      lastPublishedAt: order.lastPublishedAt,
      page,
      pageCount: Math.max(1, Math.ceil(order.ids.length / pageSize)),
      pageSize,
      tag: scope.kind === 'tag' ? scope.slug : null,
      total: order.ids.length
    }
    await writeCache('listing-name-page', cacheKey, { page: result, publicationVersion })
    return result
  }

  /**
   * Active tags (#341, design 3.1) with their hubs, public counts and newest change, from one
   * pass over tag memberships in tag order (no sort for the grouping), each membership costing
   * its index entry and its listing's row. Cached per epoch: the tag, hub and best pages, the
   * sitemaps, and the best index all read it.
   */
  async function loadTagStats(): Promise<PublishedTag[]> {
    const { key: cacheKey, publicationVersion } = await epochKey('catalog-tag-stats')
    const cached = await readCache('tag-stats', cacheKey, (value): value is TagStatsEntry =>
      isTagStatsEntry(value, publicationVersion)
    )
    if (cached) return cached.tags

    const rows = await queryAll<TagStatsRow>(
      'tag-stats',
      'tag-stats',
      parameterizedQuery<TagStatsRow>(
        `WITH counts AS (
          SELECT
            lt.tag_id,
            COUNT(*) AS listing_count,
            MAX(strftime(${ISO_INSTANT}, l.published_at)) AS published,
            MAX(strftime(${ISO_INSTANT}, l.updated_at)) AS updated
          FROM listing_tags lt INDEXED BY listing_tags_tag_idx
          CROSS JOIN listings l ON l.id = lt.listing_id
          WHERE ${publicEligibilitySql()}
          GROUP BY lt.tag_id
        )
        SELECT COALESCE((
          SELECT json_group_array(json_object(
            'slug', ordered.slug,
            'name', ordered.name,
            'description', ordered.description,
            'category', ordered.category,
            'order', ordered.sort_order,
            'count', ordered.listing_count,
            'published', ordered.published,
            'updated', ordered.updated
          ))
          FROM (
            SELECT
              t.slug,
              t.name,
              t.description,
              c.slug AS category,
              t.sort_order,
              COALESCE(counts.listing_count, 0) AS listing_count,
              counts.published,
              counts.updated
            FROM tags t
            JOIN categories c ON c.id = t.category_id
            LEFT JOIN counts ON counts.tag_id = t.id
            WHERE t.is_active = 1 AND c.is_active = 1
            ORDER BY t.sort_order ASC, t.name ASC
          ) ordered
        ), '[]') AS tags`,
        [operationTime()]
      )
    )
    const row = rows[0]
    if (!row) throw new Error('Missing D1 tag statistics.')
    const tags = parseJsonArray(row.tags, 'tag statistics').map((value, index): PublishedTag => {
      if (!value || typeof value !== 'object') throw new Error(`Invalid D1 tag ${index + 1}.`)
      const tag = value as Record<string, unknown>
      return {
        category: requireString(tag.category, `tag ${index + 1} category`),
        count: requireNonNegativeInteger(tag.count, `tag ${index + 1} count`),
        description: typeof tag.description === 'string' ? tag.description : '',
        lastModifiedAt: latestInstant(tag.published, tag.updated),
        name: requireString(tag.name, `tag ${index + 1} name`),
        order: requireNonNegativeInteger(tag.order, `tag ${index + 1} order`),
        slug: requireString(tag.slug, `tag ${index + 1} slug`)
      }
    })
    await writeCache('tag-stats', cacheKey, { publicationVersion, tags })
    return tags
  }

  function getTagStats(): Promise<PublishedTag[]> {
    tagStatsPromise ||= loadTagStats()
    return tagStatsPromise
  }

  /**
   * Every active best page with its pool size and newest change (#341, design 3.1). A tag-only
   * page's pool is its tag's public listings, which the tag stats already count, corrected for
   * its exclusions and the pins outside the tag; only a page with a category has its pool counted
   * here, from the tag's members when it also has a tag (the smaller side), else from the
   * category's. So the statement never re-reads the largest pools, the tags. Cached per epoch.
   */
  async function loadBestIndex(): Promise<PublishedBestPage[]> {
    const { key: cacheKey, publicationVersion } = await epochKey('catalog-best-index')
    const cached = await readCache('best-index', cacheKey, (value): value is BestIndexEntry =>
      isBestIndexEntry(value, publicationVersion)
    )
    if (cached) return cached.pages

    const tags = new Map((await getTagStats()).map(tag => [tag.slug, tag]))
    const asOf = operationTime()
    const notExcluded = `NOT EXISTS (
              SELECT 1 FROM best_page_listings excluded
              WHERE excluded.best_page_id = p.id AND excluded.listing_id = l.id
                AND excluded.excluded = 1
            )`
    const inTag = (listing: string) =>
      `EXISTS (SELECT 1 FROM listing_tags x WHERE x.listing_id = ${listing} AND x.tag_id = p.tag_id)`
    const inCategory = (listing: string) =>
      `EXISTS (SELECT 1 FROM listing_categories x WHERE x.listing_id = ${listing} AND x.category_id = p.category_id)`
    const rows = await queryAll<BestIndexRow>(
      'best-index',
      'best-index',
      parameterizedQuery<BestIndexRow>(
        `WITH pages AS (
          SELECT
            b.id, b.slug, b.keyword, b.title, b.heading, b.intro, b.list_size, b.sort_order,
            b.updated_at, b.tag_id, b.category_id,
            t.slug AS tag,
            c.slug AS category,
            COALESCE(c.slug, hub.slug) AS hub
          FROM best_pages b
          LEFT JOIN tags t ON t.id = b.tag_id
          LEFT JOIN categories hub ON hub.id = t.category_id
          LEFT JOIN categories c ON c.id = b.category_id
          WHERE b.is_active = 1
            AND (b.tag_id IS NULL OR t.is_active = 1)
            AND (b.category_id IS NULL OR c.is_active = 1)
        ),
        scanned AS (
          SELECT
            p.id AS page_id,
            COUNT(*) AS listing_count,
            MAX(strftime(${ISO_INSTANT}, l.published_at)) AS published,
            MAX(strftime(${ISO_INSTANT}, l.updated_at)) AS updated
          FROM pages p
          CROSS JOIN listing_tags lt INDEXED BY listing_tags_tag_idx ON lt.tag_id = p.tag_id
          CROSS JOIN listings l ON l.id = lt.listing_id
          WHERE p.category_id IS NOT NULL
            AND ${publicEligibilitySql()}
            AND ${inCategory('l.id')}
            AND ${notExcluded}
          GROUP BY p.id
          UNION ALL
          SELECT
            p.id,
            COUNT(*),
            MAX(strftime(${ISO_INSTANT}, l.published_at)),
            MAX(strftime(${ISO_INSTANT}, l.updated_at))
          FROM pages p
          CROSS JOIN listing_categories lc INDEXED BY listing_categories_category_idx
            ON lc.category_id = p.category_id
          CROSS JOIN listings l ON l.id = lc.listing_id
          WHERE p.tag_id IS NULL
            AND ${publicEligibilitySql()}
            AND ${notExcluded}
          GROUP BY p.id
        ),
        entries AS (
          SELECT
            p.id AS page_id,
            SUM(CASE WHEN e.excluded = 0
              AND NOT ((p.tag_id IS NULL OR ${inTag('l.id')})
                AND (p.category_id IS NULL OR ${inCategory('l.id')}))
              THEN 1 ELSE 0 END) AS pins_outside,
            SUM(CASE WHEN e.excluded = 1 AND p.category_id IS NULL AND ${inTag('l.id')}
              THEN 1 ELSE 0 END) AS excluded_in_tag,
            MAX(CASE WHEN e.excluded = 0 THEN strftime(${ISO_INSTANT}, l.published_at) END)
              AS published,
            MAX(CASE WHEN e.excluded = 0 THEN strftime(${ISO_INSTANT}, l.updated_at) END)
              AS updated
          FROM pages p
          CROSS JOIN best_page_listings e ON e.best_page_id = p.id
          CROSS JOIN listings l ON l.id = e.listing_id
          WHERE ${publicEligibilitySql()}
          GROUP BY p.id
        )
        SELECT
          p.slug, p.keyword, p.title, p.heading, p.intro, p.list_size, p.sort_order,
          p.updated_at, p.tag, p.category, p.hub,
          s.listing_count AS scanned_count,
          s.published AS scanned_published,
          s.updated AS scanned_updated,
          COALESCE(e.pins_outside, 0) AS pins_outside,
          COALESCE(e.excluded_in_tag, 0) AS excluded_in_tag,
          e.published AS pins_published,
          e.updated AS pins_updated
        FROM pages p
        LEFT JOIN scanned s ON s.page_id = p.id
        LEFT JOIN entries e ON e.page_id = p.id
        ORDER BY p.sort_order ASC, p.slug ASC`,
        [asOf, asOf, asOf]
      )
    )
    const pages = rows.map((row): PublishedBestPage => {
      const slug = requireString(row.slug, 'best page slug')
      const tag = row.tag === null ? null : requireString(row.tag, `best page ${slug} tag`)
      const category =
        row.category === null ? null : requireString(row.category, `best page ${slug} category`)
      const pinsOutside = requireNonNegativeInteger(row.pins_outside, 'best page pins')
      // A tag-only page's newest change is its tag's (an excluded listing's counts too). A tag the
      // tag stats lack was activated after they were read: it counts as empty this epoch.
      const tagStats = category === null && tag !== null ? tags.get(tag) : undefined
      const poolSize =
        category === null
          ? Math.max(
              0,
              (tagStats?.count ?? 0) -
                requireNonNegativeInteger(row.excluded_in_tag, 'best page exclusions') +
                pinsOutside
            )
          : (row.scanned_count ?? 0) + pinsOutside
      const lastModifiedAt = latestInstant(
        row.updated_at,
        tagStats?.lastModifiedAt,
        row.scanned_published,
        row.scanned_updated,
        row.pins_published,
        row.pins_updated
      )
      if (!lastModifiedAt) throw new Error(`Invalid D1 best page ${slug}: updated_at.`)
      return {
        category,
        heading: requireString(row.heading, `best page ${slug} heading`),
        hub: requireString(row.hub, `best page ${slug} hub`),
        intro: typeof row.intro === 'string' ? row.intro : '',
        keyword: requireString(row.keyword, `best page ${slug} keyword`),
        lastModifiedAt,
        listSize: requireNonNegativeInteger(row.list_size, `best page ${slug} list size`),
        order: requireNonNegativeInteger(row.sort_order, `best page ${slug} order`),
        poolSize,
        slug,
        tag,
        title: requireString(row.title, `best page ${slug} title`)
      }
    })
    await writeCache('best-index', cacheKey, { pages, publicationVersion })
    return pages
  }

  function getBestIndex(): Promise<PublishedBestPage[]> {
    bestIndexPromise ||= loadBestIndex()
    return bestIndexPromise
  }

  /**
   * A best page's entries (#341, design 1.3 and 3.1), in one statement: rank the pool's ids
   * (its tag's members, else its category's, plus the pins outside them), then hydrate only the
   * top `listSize`, as related listings do. SQLite evaluates select-list subqueries before it
   * sorts, so hydrating the whole pool would read categories and logos for all of it. Order: pins
   * by position, then tag centrality (`listing_tags.sort_order`), hosted logos first, then name
   * and slug; nothing a Creator pays for. Cached per epoch and page.
   */
  async function getBestPageItems(slug: string): Promise<BestPageItem[]> {
    // Only a public best page with entries reaches D1 (and the cache): never a slug from a URL.
    const page = (await getBestIndex()).find(candidate => candidate.slug === slug)
    if (!page || page.poolSize === 0) return []
    const { key, publicationVersion } = await epochKey('catalog-best-items')
    const cacheKey = `${key}:${slug}`
    const cached = await readCache('best-page-items', cacheKey, (value): value is BestItemsEntry =>
      isBestItemsEntry(value, publicationVersion)
    )
    if (cached) return cached.items

    const rows = await queryAll<BestItemRow>(
      'best-page-items',
      'best-page-items',
      parameterizedQuery<BestItemRow>(
        `WITH page AS (
          SELECT b.id, b.tag_id, b.category_id FROM best_pages b
          WHERE b.slug = ? AND b.is_active = 1
        )
        SELECT ${summaryColumns}, l.link_rel, ranked.blurb,
          COALESCE((
            SELECT json_group_array(json_object('slug', ordered.slug, 'name', ordered.name))
            FROM (
              SELECT t.slug, t.name FROM listing_tags lt
              JOIN tags t ON t.id = lt.tag_id
              WHERE lt.listing_id = l.id AND t.is_active = 1
              ORDER BY lt.sort_order ASC, t.slug ASC
              LIMIT ${BEST_ITEM_TAGS}
            ) ordered
          ), '[]') AS tags
        FROM (
          SELECT
            l.id,
            pin.position,
            pin.blurb,
            pool.centrality,
            NOT EXISTS (
              SELECT 1 FROM listing_media m
              WHERE m.listing_id = l.id AND m.kind = 'logo' AND m.media_key IS NOT NULL
            ) AS unhosted,
            l.name,
            l.slug
          FROM (
            SELECT lt.listing_id AS id, lt.sort_order AS centrality
            FROM listing_tags lt INDEXED BY listing_tags_tag_idx
            WHERE lt.tag_id = (SELECT tag_id FROM page)
            UNION ALL
            SELECT lc.listing_id, 0
            FROM listing_categories lc INDEXED BY listing_categories_category_idx
            WHERE lc.category_id = (SELECT category_id FROM page)
              AND (SELECT tag_id FROM page) IS NULL
            UNION ALL
            SELECT e.listing_id, NULL
            FROM page p
            CROSS JOIN best_page_listings e ON e.best_page_id = p.id
            WHERE e.excluded = 0
              AND NOT EXISTS (
                SELECT 1 FROM listing_tags x WHERE x.listing_id = e.listing_id AND x.tag_id = p.tag_id
              )
              AND (p.tag_id IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM listing_categories x
                WHERE x.listing_id = e.listing_id AND x.category_id = p.category_id
              ))
          ) pool
          CROSS JOIN page p
          CROSS JOIN listings l ON l.id = pool.id
          LEFT JOIN best_page_listings pin ON pin.best_page_id = p.id AND pin.listing_id = l.id
          WHERE ${publicEligibilitySql()}
            AND (pin.listing_id IS NULL OR pin.excluded = 0)
            AND (pin.position IS NOT NULL OR p.tag_id IS NULL OR p.category_id IS NULL OR EXISTS (
              SELECT 1 FROM listing_categories x
              WHERE x.listing_id = l.id AND x.category_id = p.category_id
            ))
          ORDER BY pin.position IS NULL, pin.position, pool.centrality, unhosted, l.name, l.slug
          LIMIT ?
        ) ranked
        CROSS JOIN listings l ON l.id = ranked.id
        ORDER BY ranked.position IS NULL, ranked.position, ranked.centrality, ranked.unhosted,
          ranked.name, ranked.slug`,
        [slug, operationTime(), page.listSize]
      )
    )
    const items = rows.map((row): BestPageItem => {
      if (!runtimeLinkRels.has(row.link_rel)) {
        throw new Error(`Invalid D1 listing ${row.slug} link rel.`)
      }
      const blurb = row.blurb ? requireString(row.blurb, 'best page blurb') : undefined
      return {
        ...mapSummary(row),
        ...(blurb ? { blurb } : {}),
        linkRel: row.link_rel as ListingLinkRel,
        tags: mapListingTags(row.tags)
      }
    })
    await writeCache('best-page-items', cacheKey, { items, publicationVersion })
    return items
  }

  /**
   * Where a retired or renamed taxonomy URL moved (#341, design 2.2): one primary-key seek and
   * at most one seek on its target. Uncached, like `getCanonicalSlugForRedirect`: it runs only
   * after a hub, tag or best page missed.
   */
  async function getTaxonomyRedirect(
    kind: TaxonomyKind,
    slug: string
  ): Promise<TaxonomyTarget | null> {
    const rows = await queryAll<TaxonomyRedirectRow>(
      'taxonomy-redirect',
      'taxonomy-redirect',
      parameterizedQuery<TaxonomyRedirectRow>(
        `SELECT r.target_kind AS kind, ${TAXONOMY_TARGET_SLUG} AS slug
        FROM taxonomy_redirects r
        ${TAXONOMY_TARGET_JOINS}
        WHERE r.source_kind = ? AND r.source_slug = ?
        LIMIT 1`,
        [kind, slug]
      )
    )
    const row = rows[0]
    const target = row ? parseTaxonomyTarget(row.kind, row.slug) : null
    return target && (await taxonomyTargetRenders(target)) ? target : null
  }

  /**
   * Whether a moved URL's target page renders (#346 review), by that page's own rule, so a moved
   * URL never answers 308 to a 404: a category or tag with a public listing, a best page with an
   * entry, or the directory. Read from the cached shell stats, tag stats and best index the pages
   * read anyway, so it adds no statement on a warm cache. `legacyRootTarget` applies the same rule
   * in SQL for the Worker's root-level redirect.
   */
  async function taxonomyTargetRenders(target: TaxonomyTarget): Promise<boolean> {
    switch (target.kind) {
      case 'directory':
        return true
      case 'category':
        return (await getShellStats()).categories.some(
          category => category.slug === target.slug && category.count > 0
        )
      case 'tag':
        return (await getTagStats()).some(tag => tag.slug === target.slug && tag.count > 0)
      case 'best':
        return (await getBestIndex()).some(
          page => page.slug === target.slug && Math.min(page.listSize, page.poolSize) > 0
        )
    }
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
   * Every normalized term must occur in the listing's name, short description, slug (the
   * product's domain), or the slug or name of one of its active categories or tags (owner
   * decisions on #77 and #81; #341 design 3.3). Never the long content, and never the website
   * URL: almost every website is a `serp.ly` affiliate link, so its host would match nearly every
   * short term.
   * The terms are one JSON binding that each term reads with `json_extract(?1, '$[i]')`, and
   * matching uses `instr()`, so the statement binds four values whatever the query and has no
   * LIKE/GLOB pattern for D1's 50-byte limit. The category and tag matches are uncorrelated `IN`
   * subqueries, which SQLite builds once per statement from the matching categories' and tags'
   * members instead of looking up each listing's memberships, so a typical search stays near one
   * read per listing. A term that nearly every category and tag contains builds a set of nearly
   * every membership, so the widest searches (several such one-character terms) cost up to one
   * pass over the memberships per term (`BROAD_SEARCH_ROWS_READ_BUDGET` in
   * `scripts/d1-workerd-queries.test.ts`, #362 review). Results are cached per epoch.
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
      const termText = (alias: string) =>
        `(instr(lower(${alias}.slug), ${term}) > 0 OR instr(lower(${alias}.name), ${term}) > 0)`
      return `(
            instr(lower(l.name), ${term}) > 0
            OR instr(lower(l.description), ${term}) > 0
            OR instr(lower(l.slug), ${term}) > 0
            OR l.id IN (
              SELECT lc.listing_id
              FROM categories c
              CROSS JOIN listing_categories lc INDEXED BY listing_categories_category_idx
                ON lc.category_id = c.id
              WHERE c.is_active = 1 AND ${termText('c')}
            )
            OR l.id IN (
              SELECT lt.listing_id
              FROM tags t
              CROSS JOIN listing_tags lt INDEXED BY listing_tags_tag_idx ON lt.tag_id = t.id
              WHERE t.is_active = 1 AND ${termText('t')}
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
    getActiveTags: getTagStats,
    async getAutocomplete(query, limit = 8) {
      return searchListings(query, limit)
    },
    async getBestPageBySlug(slug) {
      return (await getBestIndex()).find(page => page.slug === slug) || null
    },
    getBestPageItems,
    getBestPages: getBestIndex,
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
    getDerivedValue,
    async getLatestListings(limit = 12) {
      return publicationHead('latest-summaries', limit)
    },
    getListingBySlug,
    getListingNamePage,
    getPublicationVersion,
    getPublishedListings,
    getShellStats,
    getSitemapListings: getPublishedListings,
    async getTagBySlug(slug) {
      return (await getTagStats()).find(tag => tag.slug === slug) || null
    },
    getTaxonomyRedirect,
    getUnpublishedListing,
    searchListings
  }
}
