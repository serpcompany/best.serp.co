/**
 * The XML sitemaps and robots.txt, all read from the route registry
 * (`@serpdirectory/site-config` `siteRoutes`, #167). `/sitemap-index.xml` lists the three
 * root-level child sitemaps (serp websites/features/xml-sitemaps.md): `/sitemap-pages.xml` (the
 * registry's indexable static pages), `/sitemap-products.xml` (every public listing), and
 * `/sitemap-categories.xml` (every category with a public listing).
 *
 * `lastmod` comes from D1 (#218): a listing's `modifiedAt` (the later of `updated_at` and
 * `published_at`), a category's newest listing, the catalog pages' newest listing, and each
 * index entry's newest child. A static page whose content lives in code carries none.
 */
import {
  disallowedPaths,
  SITEMAP_INDEX_PATH,
  type SitemapGroup,
  sitemapGroups,
  sitemapPaths,
  sitemapRoutePaths
} from '@serpdirectory/site-config'
import type { MetadataRoute } from 'next'
import { absoluteUrl } from './canonical-url'
import { getActiveCategories } from './category-navigation'
import { getRoute } from './routes'
import { SITE_PUBLIC_URL } from './seo-config'
import { siteConfig } from './site-config'

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

type SitemapContentLoaders = {
  getWebsites: () => Promise<WebsiteSitemapEntry[]> | WebsiteSitemapEntry[]
}

/**
 * Sitemap entries match the page canonical exactly: the homepage is the bare origin, pages
 * end with a slash, and sitemap files never do (see `./canonical-url`).
 */
function toAbsoluteUrl(path: string, baseUrl = SITE_PUBLIC_URL): string {
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
    .map(category => ({
      lastmod: latestBySlug.get(category.slug),
      loc: toAbsoluteUrl(getRoute('category.page', { category: category.slug }))
    }))
    .sort((left, right) => left.loc.localeCompare(right.loc))
}

function getPageEntries(websites: WebsiteSitemapEntry[]): SitemapEntry[] {
  const catalogLastmod = newest(websites.map(listingLastmod))
  return sitemapRoutePaths('pages').map(path => ({
    lastmod: CATALOG_PAGE_PATHS.has(path) ? catalogLastmod : undefined,
    loc: toAbsoluteUrl(path)
  }))
}

export function createCanonicalRobots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/'],
      disallow: disallowedPaths()
    },
    sitemap: toAbsoluteUrl(SITEMAP_INDEX_PATH)
  }
}

export async function createSitemapIndexResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  const websites = await loaders.getWebsites()
  const entriesByGroup: Record<SitemapGroup, SitemapEntry[]> = {
    categories: getCategoryEntries(websites),
    pages: getPageEntries(websites),
    products: getListingEntries(websites)
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
  return toXmlResponse(renderSitemap(getPageEntries(await loaders.getWebsites())))
}

export async function createListingsSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(getListingEntries(await loaders.getWebsites())))
}

export async function createTaxonomiesSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(getCategoryEntries(await loaders.getWebsites())))
}
