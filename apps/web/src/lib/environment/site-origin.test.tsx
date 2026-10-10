/**
 * #359: every absolute URL a page, sitemap or feed writes takes the environment's origin per
 * request: `https://staging.best.serp.co` on staging, which describes itself as best.serp.co
 * will, and `https://best.serp.co` everywhere else, exactly as before. Each builder runs inside a
 * stand-in for OpenNext's request context (the Worker's vars), the way a render reads it.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paginatedMetadata } from '@/components/directory/listing-pagination'
import { HomePageCanonicalTags, homePageMetadata } from '@/components/home/home-page'
import { notFoundMetadata } from '@/components/layout/not-found-content'
import { rootLayoutMetadata } from '@/components/layout/root-shell'
import { generateWebsiteDetailSchema } from '../seo/schema'
import {
  defaultOgImage,
  generateBaseMetadata,
  generateBreadcrumbSchema,
  generateCollectionSchema,
  generateDynamicMetadata,
  generateWebsiteSchema,
  siteUrl
} from '../seo/seo-config'
import {
  createCanonicalRobots,
  createListingsSitemapResponse,
  createPagesSitemapResponse,
  createSitemapIndexResponse,
  createTaxonomiesSitemapResponse
} from '../seo/sitemaps'
import { siteOrigin } from './site-origin'

const websites = vi.hoisted(() => [
  {
    category: 'video-downloaders',
    description: 'Downloads videos.',
    modifiedAt: '2026-09-30T12:00:00.000Z',
    name: 'Autoenhance',
    publishedAt: '2026-05-16',
    slug: 'autoenhance.ai'
  }
])
vi.mock('@/lib/content-loader', () => ({ getWebsites: async () => websites }))

const CONTEXT = Symbol.for('__cloudflare-context__')
const PRODUCTION = 'https://best.serp.co'
const STAGING = 'https://staging.best.serp.co'

function runAs(env: Record<string, string> | null): void {
  const global = globalThis as Record<symbol, unknown>
  if (env) global[CONTEXT] = { env }
  else delete global[CONTEXT]
}

/** Everything a request writes, as text: metadata, JSON-LD, sitemaps, the feed, the tags. */
async function everythingWritten(): Promise<string> {
  const loaders = { getWebsites: () => websites }
  const { GET: rss } = await import('../../app/(files)/rss.xml/route')
  const base = generateBaseMetadata({ description: 'd', path: '/about/', title: 't' })
  return [
    JSON.stringify(rootLayoutMetadata()),
    JSON.stringify(base),
    JSON.stringify(homePageMetadata()),
    JSON.stringify(notFoundMetadata()),
    JSON.stringify(paginatedMetadata(base, { basePath: '/products/', page: 2 })),
    JSON.stringify(
      generateDynamicMetadata({
        description: 'd',
        name: 'Autoenhance',
        publishedAt: '2026-05-16',
        slug: 'autoenhance.ai',
        type: 'listing'
      })
    ),
    JSON.stringify(defaultOgImage()),
    JSON.stringify(generateWebsiteSchema()),
    JSON.stringify(
      generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'About', url: '/about/' }
      ])
    ),
    JSON.stringify(
      generateCollectionSchema({ description: 'd', itemCount: 1, name: 'n', url: '/products/' })
    ),
    JSON.stringify(
      generateWebsiteDetailSchema({ ...websites[0], media: { logo: '/listing-logos/a.png' } })
    ),
    await (await createSitemapIndexResponse(loaders)).text(),
    await (await createPagesSitemapResponse(loaders)).text(),
    await (await createListingsSitemapResponse(loaders)).text(),
    await (await createTaxonomiesSitemapResponse(loaders)).text(),
    await (await rss()).text(),
    renderToStaticMarkup(<HomePageCanonicalTags />)
  ].join('\n')
}

describe("each request's origin", () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    runAs(null)
    vi.unstubAllGlobals()
  })

  it('reads the origin from the Worker vars of the request', () => {
    runAs({ SITE_ENVIRONMENT: 'staging' })
    expect(siteOrigin()).toBe(STAGING)
    expect(siteUrl('/')).toBe(STAGING)
    expect(siteUrl('/about')).toBe(`${STAGING}/about/`)
    runAs({ D1_RUNTIME_ENV: 'local', LOCAL_STAGING_ACCESS: 'on', SITE_ENVIRONMENT: 'local' })
    expect(siteOrigin()).toBe(STAGING)
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      {}
    ]) {
      runAs(env)
      expect(siteOrigin(), JSON.stringify(env)).toBe(PRODUCTION)
    }
    // Outside a request (tests, the build) there is no context: production's origin.
    runAs(null)
    expect(siteOrigin()).toBe(PRODUCTION)
  })

  it("writes only staging's origin on staging, in every absolute URL", async () => {
    runAs({ SITE_ENVIRONMENT: 'staging' })
    const written = await everythingWritten()
    expect(written).toContain(`"canonical":"${STAGING}/about/"`)
    expect(written).toContain(`<loc>${STAGING}/products/autoenhance.ai/</loc>`)
    expect(written).toContain(`"home_page_url":"${STAGING}"`)
    expect(written).toContain(`"@id":"${STAGING}/#website"`)
    expect(written).toContain(`href="${STAGING}"`)
    // `https://staging.best.serp.co` does not contain `https://best.serp.co`.
    expect(written).not.toContain(PRODUCTION)
  })

  it('writes best.serp.co everywhere else, exactly as before #359', async () => {
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      null
    ]) {
      runAs(env)
      const written = await everythingWritten()
      expect(written, JSON.stringify(env)).toContain(`"canonical":"${PRODUCTION}/about/"`)
      expect(written).toContain(`<loc>${PRODUCTION}/products/autoenhance.ai/</loc>`)
      expect(written).toContain(`"home_page_url":"${PRODUCTION}"`)
      expect(written).not.toContain('staging')
    }
  })

  it("builds the static robots.txt route, outside any request, with best.serp.co's sitemap", () => {
    // The route is prerendered at build time; the Worker answers robots.txt itself everywhere
    // but best.serp.co (`stagingRobotsTxt` on staging).
    expect(createCanonicalRobots().sitemap).toBe(`${PRODUCTION}/sitemap-index.xml`)
  })
})
