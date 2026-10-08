/**
 * The XML sitemaps and robots.txt, all read from the route registry
 * (`@serpdirectory/site-config` `siteRoutes`, #167). `/sitemap-index.xml` lists the three
 * root-level child sitemaps (serp websites/features/xml-sitemaps.md): `/sitemap-pages.xml` (the
 * registry's indexable static pages), `/sitemap-products.xml` (every public listing), and
 * `/sitemap-categories.xml` (every category with a public listing).
 */
import {
  disallowedPaths,
  SITEMAP_INDEX_PATH,
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

/**
 * The listing pages. `lastmod` is the publication date until the sitemaps read D1's
 * `updated_at` (#167 follow-up); the static pages and categories carry none rather than a
 * generation time that would claim every page changed on every request.
 */
async function getListingEntries(
  getWebsites: SitemapContentLoaders['getWebsites']
): Promise<SitemapEntry[]> {
  return (await getWebsites()).map(website => ({
    lastmod: new Date(website.publishedAt).toISOString(),
    loc: toAbsoluteUrl(
      appendPathSegment(
        getRoute('listing.detail', { slug: website.slug }),
        siteConfig.sitemap.listingDetailSuffix
      )
    )
  }))
}

async function getCategoryEntries(
  getWebsites: SitemapContentLoaders['getWebsites']
): Promise<SitemapEntry[]> {
  return getActiveCategories(await getWebsites())
    .map(category => toAbsoluteUrl(getRoute('category.page', { category: category.slug })))
    .sort()
    .map(loc => ({ loc }))
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

export function createSitemapIndexResponse(): Response {
  return toXmlResponse(
    renderSitemapIndex(sitemapGroups.map(group => ({ loc: toAbsoluteUrl(sitemapPaths[group]) })))
  )
}

export function createPagesSitemapResponse(): Response {
  return toXmlResponse(
    renderSitemap(sitemapRoutePaths('pages').map(path => ({ loc: toAbsoluteUrl(path) })))
  )
}

export async function createListingsSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(await getListingEntries(loaders.getWebsites)))
}

export async function createTaxonomiesSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(await getCategoryEntries(loaders.getWebsites)))
}
