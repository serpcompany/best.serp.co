import type { MetadataRoute } from 'next'
import { NextResponse } from 'next/server'
import { getActiveCategories, hasFeaturedListings } from './category-navigation'
import { getFeaturedCategoryRoute, getRoute } from './routes'
import { SITE_PUBLIC_URL } from './seo-config'
import { siteConfig } from './site-config'

type WebsiteSitemapEntry = {
  categories?: string[]
  category?: string
  featured?: boolean
  publishedAt: string
  slug: string
}

type DocSitemapEntry = {
  slug: string
}

type GuideSitemapEntry = {
  slug: string
}

type SitemapEntry = {
  loc: string
  lastmod?: string
}

type SitemapContentLoaders = {
  getDocs?: () => DocSitemapEntry[]
  getGuides?: () => GuideSitemapEntry[]
  getWebsites: () => Promise<WebsiteSitemapEntry[]> | WebsiteSitemapEntry[]
}

const CANONICAL_SITEMAP_INDEX_PATH = '/sitemap-index.xml'
const PUBLIC_FILE_EXTENSION_PATTERN =
  /\.(?:css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webp|woff2?|xml)$/i

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function withTrailingSlash(path: string): string {
  if (path === '/') {
    return path
  }

  const lastSegment = path.split('/').at(-1) ?? ''

  if (path.endsWith('/') || PUBLIC_FILE_EXTENSION_PATTERN.test(lastSegment)) {
    return path
  }

  return `${path}/`
}

function toAbsoluteUrl(
  path: string,
  baseUrl = SITE_PUBLIC_URL,
  options: { trailingSlash?: boolean } = {}
): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedPath = options.trailingSlash ? withTrailingSlash(path) : path
  return normalizedPath === '/' ? `${normalizedBaseUrl}/` : `${normalizedBaseUrl}${normalizedPath}`
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

function renderSitemap(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(entry => {
      const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ''
      return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`
    }),
    '</urlset>'
  ].join('')
}

function renderSitemapIndex(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(entry => {
      const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ''
      return `<sitemap><loc>${escapeXml(entry.loc)}</loc>${lastmod}</sitemap>`
    }),
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

function sortUniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort((left, right) => {
    if (left === '/') {
      return -1
    }

    if (right === '/') {
      return 1
    }

    return left.localeCompare(right)
  })
}

function normalizeComparablePath(path: string): string {
  if (path === '/') {
    return path
  }

  return `/${path.replace(/^\/+|\/+$/g, '')}`
}

function withoutConfiguredExcludedPaths(paths: string[]): string[] {
  const excludedPaths = new Set(
    (siteConfig.sitemap.excludedPaths ?? []).map(path => normalizeComparablePath(path))
  )
  return paths.filter(path => !excludedPaths.has(normalizeComparablePath(path)))
}

function getBuildDate(): string {
  return new Date().toISOString()
}

function buildUrlEntries(paths: string[], baseUrl = SITE_PUBLIC_URL): SitemapEntry[] {
  const buildDate = getBuildDate()

  return sortUniquePaths(paths).map(path => ({
    lastmod: buildDate,
    loc: toAbsoluteUrl(path, baseUrl, { trailingSlash: true })
  }))
}

function getStaticPagePaths(): string[] {
  if (siteConfig.sitemap.staticPagePaths?.length) {
    return withoutConfiguredExcludedPaths([
      ...siteConfig.sitemap.staticPagePaths,
      ...(siteConfig.sitemap.additionalPathsByGroup?.pages ?? [])
    ])
  }

  return withoutConfiguredExcludedPaths([
    '/',
    getRoute('about'),
    getRoute('affiliateDisclosure'),
    getRoute('privacy'),
    getRoute('cookies'),
    getRoute('dmca'),
    getRoute('terms'),
    ...(siteConfig.features.showBrands ? [getRoute('brands')] : []),
    ...(siteConfig.features.showProjects ? [getRoute('projects')] : []),
    ...(siteConfig.sitemap.additionalPathsByGroup?.pages ?? [])
  ])
}

function getDocsPaths(getDocs: (() => DocSitemapEntry[]) | undefined): string[] {
  if (!siteConfig.features.showDocs || !getDocs) {
    return []
  }

  return [getRoute('docs.list'), ...getDocs().map(doc => getRoute('docs.doc', { slug: doc.slug }))]
}

function getPostsPaths(getGuides: (() => GuideSitemapEntry[]) | undefined): string[] {
  if (!siteConfig.features.showGuides || !getGuides) {
    return []
  }

  return [
    getRoute('guides.list'),
    ...getGuides().map(guide => getRoute('guides.guide', { slug: guide.slug }))
  ]
}

async function getListingPaths(
  getWebsites: SitemapContentLoaders['getWebsites']
): Promise<SitemapEntry[]> {
  return (await getWebsites())
    .map(website => ({
      lastmod: new Date(website.publishedAt).toISOString(),
      loc: toAbsoluteUrl(
        appendPathSegment(
          getRoute('listing.detail', { slug: website.slug }),
          siteConfig.sitemap.listingDetailSuffix
        ),
        SITE_PUBLIC_URL,
        { trailingSlash: true }
      )
    }))
    .filter(entry => {
      const excludedPaths = new Set(
        (siteConfig.sitemap.excludedPaths ?? []).map(path => normalizeComparablePath(path))
      )
      return !excludedPaths.has(normalizeComparablePath(new URL(entry.loc).pathname))
    })
}

async function getTaxonomyPaths(
  getWebsites: SitemapContentLoaders['getWebsites']
): Promise<string[]> {
  const websites = await getWebsites()
  const paths = siteConfig.sitemap.categoryBasePath ? [] : [getRoute('listing.list')]
  const activeCategories = getActiveCategories(websites)

  for (const category of activeCategories) {
    if (siteConfig.sitemap.categoryBasePath) {
      paths.push(`/${siteConfig.sitemap.categoryBasePath}/${category.slug}`)
      continue
    }

    paths.push(getRoute('category.page', { category: category.slug }))
  }

  if (hasFeaturedListings(websites)) {
    paths.push(getFeaturedCategoryRoute())
  }

  return withoutConfiguredExcludedPaths([
    ...paths,
    ...(siteConfig.sitemap.additionalPathsByGroup?.taxonomies ?? [])
  ])
}

function getIndexEntries(loaders: SitemapContentLoaders): SitemapEntry[] {
  const buildDate = getBuildDate()
  const entries: SitemapEntry[] = [
    {
      lastmod: buildDate,
      loc: toAbsoluteUrl(siteConfig.sitemap.pathByGroup?.pages || '/pages-sitemap.xml')
    },
    {
      lastmod: buildDate,
      loc: toAbsoluteUrl(siteConfig.sitemap.pathByGroup?.listings || '/listings-sitemap.xml')
    },
    {
      lastmod: buildDate,
      loc: toAbsoluteUrl(siteConfig.sitemap.pathByGroup?.taxonomies || '/taxonomies-sitemap.xml')
    }
  ]

  if (getDocsPaths(loaders.getDocs).length > 0) {
    entries.push({
      lastmod: buildDate,
      loc: toAbsoluteUrl(siteConfig.sitemap.pathByGroup?.docs || '/docs-sitemap.xml')
    })
  }

  if (getPostsPaths(loaders.getGuides).length > 0) {
    entries.push({
      lastmod: buildDate,
      loc: toAbsoluteUrl(siteConfig.sitemap.pathByGroup?.posts || '/posts-sitemap.xml')
    })
  }

  return entries
}

export function createCanonicalRobots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/'],
      disallow: ['/404', '/500', '/submit', '/search']
    },
    sitemap: toAbsoluteUrl(CANONICAL_SITEMAP_INDEX_PATH)
  }
}

export function createSitemapCompatibilityRedirect(): Response {
  return NextResponse.redirect(toAbsoluteUrl(CANONICAL_SITEMAP_INDEX_PATH), {
    status: 307
  })
}

export function createSitemapIndexResponse(loaders: SitemapContentLoaders): Response {
  return toXmlResponse(renderSitemapIndex(getIndexEntries(loaders)))
}

export function createPagesSitemapResponse(): Response {
  return toXmlResponse(renderSitemap(buildUrlEntries(getStaticPagePaths())))
}

export async function createListingsSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(await getListingPaths(loaders.getWebsites)))
}

export async function createTaxonomiesSitemapResponse(
  loaders: SitemapContentLoaders
): Promise<Response> {
  return toXmlResponse(renderSitemap(buildUrlEntries(await getTaxonomyPaths(loaders.getWebsites))))
}

export function createDocsSitemapResponse(loaders: SitemapContentLoaders): Response {
  return toXmlResponse(renderSitemap(buildUrlEntries(getDocsPaths(loaders.getDocs))))
}

export function createPostsSitemapResponse(loaders: SitemapContentLoaders): Response {
  return toXmlResponse(renderSitemap(buildUrlEntries(getPostsPaths(loaders.getGuides))))
}
