/**
 * The XML sitemaps and robots.txt, all read from the route registry
 * (`@/lib/site` `siteRoutes`, #167). `/sitemap-index.xml` lists the five
 * root-level child sitemaps (serp websites/features/xml-sitemaps.md): `/sitemap-pages.xml` (the
 * registry's indexable static pages), `/sitemap-products.xml` (every public listing),
 * `/sitemap-categories.xml` (every indexable category with a public listing), and, for the
 * taxonomy (#341, design 2.3), `/sitemap-tags.xml` and `/sitemap-best.xml` (every indexable tag
 * and best page, by the predicates their pages' metadata uses: `./taxonomy-indexing.ts`).
 *
 * `lastmod` comes from D1 (#218): a listing's `modifiedAt` (the later of `updated_at` and
 * `published_at`), a category's or tag's newest listing, a best page's later of its own change
 * and its pool's newest listing, the catalog pages' newest listing, and each index entry's newest
 * child. A static page whose content lives in code carries none.
 */

import type { MetadataRoute } from 'next'
import type { PublishedBestPage, PublishedTag } from '@/db/contracts'
import {
  crawlRules,
  SITEMAP_INDEX_PATH,
  type SitemapGroup,
  sitemapGroups,
  sitemapPaths,
  sitemapRoutePaths
} from '@/lib/site'
import { getActiveCategories } from '../directory/category-navigation'
import { getRoute } from '../routing/routes'
import { siteConfig } from '../site/site-config'
import { absoluteUrl } from './canonical-url'
import { siteOrigin } from './seo-config'
import {
  isBestPageIndexable,
  isCategoryIndexable,
  isTagIndexable,
  linkedTags,
  listedBestPages
} from './taxonomy-indexing'

type WebsiteSitemapEntry = {
  categories?: string[]
  category?: string
  featured?: boolean
  modifiedAt?: string
  publishedAt: string
  slug: string
}

type SitemapEntry = {
  loc: string
  lastmod?: string
}

type TagSitemapEntry = Pick<PublishedTag, 'count' | 'lastModifiedAt' | 'slug'>
type BestPageSitemapEntry = Pick<
  PublishedBestPage,
  'category' | 'lastModifiedAt' | 'listSize' | 'poolSize' | 'slug' | 'tag'
>

type SitemapContentLoaders = {
  /** Active best pages with their pool sizes (the best index, #341). */
  getBestPages: () => Promise<BestPageSitemapEntry[]> | BestPageSitemapEntry[]
  /** Active tags with their public counts (#341). */
  getTags: () => Promise<TagSitemapEntry[]> | TagSitemapEntry[]
  getWebsites: () => Promise<WebsiteSitemapEntry[]> | WebsiteSitemapEntry[]
}

type SitemapContent = {
  bestPages: BestPageSitemapEntry[]
  tags: TagSitemapEntry[]
  websites: WebsiteSitemapEntry[]
}

async function loadContent(loaders: SitemapContentLoaders): Promise<SitemapContent> {
  const [websites, tags, bestPages] = await Promise.all([
    loaders.getWebsites(),
    loaders.getTags(),
    loaders.getBestPages()
  ])
  return { bestPages, tags, websites }
}

/**
 * Sitemap entries match the page canonical exactly: the homepage is the bare origin, pages
 * end with a slash, and sitemap files never do (see `./canonical-url.ts`).
 */
function toAbsoluteUrl(path: string, baseUrl = siteOrigin()): string {
  return absoluteUrl(baseUrl, path)
}

function appendPathSegment(path: string, segment: string | undefined): string {
  if (!segment) {
    return path
  }

  const normalizedSegment = segment.replace(/^\/+|\/+$/g, '')

  if (!normalizedSegment) {
    return path
  }

  if (path.replace(/\/+$/g, '').endsWith(`/${normalizedSegment}`)) {
    return path
  }

  return `${path.replace(/\/+$/g, '')}/${normalizedSegment}`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function renderEntry(tag: 'sitemap' | 'url', entry: SitemapEntry): string {
  const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ''
  return `<${tag}><loc>${escapeXml(entry.loc)}</loc>${lastmod}</${tag}>`
}

function renderSitemap(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(entry => renderEntry('url', entry)),
    '</urlset>'
  ].join('')
}

function renderSitemapIndex(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(entry => renderEntry('sitemap', entry)),
    '</sitemapindex>'
  ].join('')
}

function toXmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8'
    }
  })
}

/** The static pages that show the catalog, so they change when a listing does. */
const CATALOG_PAGE_PATHS = new Set(['/', getRoute('category.index')])

function listingLastmod(website: WebsiteSitemapEntry): string {
  return website.modifiedAt ?? new Date(website.publishedAt).toISOString()
}

/** The newest of ISO instants (they sort as text), or undefined for none. */
function newest(values: Array<string | undefined>): string | undefined {
  return values.reduce<string | undefined>(
    (latest, value) => (value && (!latest || value > latest) ? value : latest),
    undefined
  )
}

function byLocation(left: SitemapEntry, right: SitemapEntry): number {
  return left.loc.localeCompare(right.loc)
}

function getListingEntries(websites: WebsiteSitemapEntry[]): SitemapEntry[] {
  return websites.map(website => ({
    lastmod: listingLastmod(website),
    loc: toAbsoluteUrl(
      appendPathSegment(
        getRoute('listing.detail', { slug: website.slug }),
        siteConfig.sitemap.listingDetailSuffix
      )
    )
  }))
}

function getCategoryEntries(websites: WebsiteSitemapEntry[]): SitemapEntry[] {
  const latestBySlug = new Map<string, string>()
  for (const website of websites) {
    const lastmod = listingLastmod(website)
    for (const slug of website.categories ?? (website.category ? [website.category] : [])) {
      const latest = latestBySlug.get(slug)
      if (!latest || lastmod > latest) latestBySlug.set(slug, lastmod)
    }
  }
  return getActiveCategories(websites)
    .filter(isCategoryIndexable)
    .map(category => ({
      lastmod: latestBySlug.get(category.slug),
      loc: toAbsoluteUrl(getRoute('category.page', { category: category.slug }))
    }))
    .sort(byLocation)
}

function getTagEntries({ bestPages, tags }: SitemapContent): SitemapEntry[] {
  return tags
    .filter(tag => isTagIndexable(tag, bestPages))
    .map(tag => ({
      lastmod: tag.lastModifiedAt ?? undefined,
      loc: toAbsoluteUrl(getRoute('tag.page', { tag: tag.slug }))
    }))
    .sort(byLocation)
}

function getBestPageEntries({ bestPages }: SitemapContent): SitemapEntry[] {
  return bestPages
    .filter(isBestPageIndexable)
    .map(page => ({
      lastmod: page.lastModifiedAt,
      loc: toAbsoluteUrl(getRoute('best.page', { keyword: page.slug }))
    }))
    .sort(byLocation)
}

/**
 * The taxonomy indexes list only the tags and best pages that render, so each is in the pages
 * sitemap (with its newest entry's lastmod) only while it lists one; before, it renders noindex.
 * Each index path maps to the lastmods of what it lists; a static page not here is always listed.
 */
function taxonomyIndexLastmods({
  bestPages,
  tags
}: SitemapContent): Map<string, Array<string | undefined>> {
  return new Map([
    [getRoute('tag.index'), linkedTags(tags).map(tag => tag.lastModifiedAt ?? undefined)],
    [getRoute('best.index'), listedBestPages(bestPages).map(page => page.lastModifiedAt)]
  ])
}

function getPageEntries(content: SitemapContent): SitemapEntry[] {
  const catalogLastmod = newest(content.websites.map(listingLastmod))
  const indexes = taxonomyIndexLastmods(content)
  return sitemapRoutePaths('pages').flatMap(path => {
    const listed = indexes.get(path)
    if (listed?.length === 0) return []
    const lastmod = listed
      ? newest(listed)
      : CATALOG_PAGE_PATHS.has(path)
        ? catalogLastmod
        : undefined
    return [{ lastmod, loc: toAbsoluteUrl(path) }]
  })
}

export function createCanonicalRobots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', ...crawlRules() },
    sitemap: toAbsoluteUrl(SITEMAP_INDEX_PATH)
  }
}

export async function createSitemapIndexResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  const content = await loadContent(loaders)
  const entriesByGroup: Record<SitemapGroup, SitemapEntry[]> = {
    best: getBestPageEntries(content),
    categories: getCategoryEntries(content.websites),
    pages: getPageEntries(content),
    products: getListingEntries(content.websites),
    tags: getTagEntries(content)
  }
  return toXmlResponse(
    renderSitemapIndex(
      sitemapGroups.map(group => ({
        lastmod: newest(entriesByGroup[group].map(entry => entry.lastmod)),
        loc: toAbsoluteUrl(sitemapPaths[group])
      }))
    )
  )
}

export async function createPagesSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(getPageEntries(await loadContent(loaders))))
}

export async function createListingsSitemapResponse(
  loaders: Pick<SitemapContentLoaders, 'getWebsites'>
): Promise<Response> {
  return toXmlResponse(renderSitemap(getListingEntries(await loaders.getWebsites())))
}

export async function createTaxonomiesSitemapResponse(
  loaders: Pick<SitemapContentLoaders, 'getWebsites'>
): Promise<Response> {
  return toXmlResponse(renderSitemap(getCategoryEntries(await loaders.getWebsites())))
}

/** `/sitemap-tags.xml`: every indexable tag (`isTagIndexable`), with its newest listing. */
export async function createTagsSitemapResponse(
  loaders: Pick<SitemapContentLoaders, 'getBestPages' | 'getTags'>
): Promise<Response> {
  const [tags, bestPages] = await Promise.all([loaders.getTags(), loaders.getBestPages()])
  return toXmlResponse(renderSitemap(getTagEntries({ bestPages, tags, websites: [] })))
}

/** `/sitemap-best.xml`: every indexable best page (`isBestPageIndexable`). */
export async function createBestPagesSitemapResponse(
  loaders: Pick<SitemapContentLoaders, 'getBestPages'>
): Promise<Response> {
  const bestPages = await loaders.getBestPages()
  return toXmlResponse(renderSitemap(getBestPageEntries({ bestPages, tags: [], websites: [] })))
}
