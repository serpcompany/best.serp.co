/**
 * The route registry (`@/lib/site` `siteRoutes`, #167) against everything that
 * reads it: the sitemaps, robots.txt, page metadata, and the footer. The page modules' own
 * metadata is checked against it in `apps/web/src/lib/environment/noindex-sources.test.ts`.
 */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isReservedListingSlug,
  reservedListingSlugs,
  SITEMAP_INDEX_PATH,
  site,
  sitemapPaths,
  siteRoutes,
  taxonomyRoutePaths
} from '@/lib/site'
import {
  bestIndexRoute,
  bestRoute,
  catalogSitemapRoutes,
  tagIndexRoute,
  tagRoute
} from '../../../../../scripts/site-routes'
import { SiteFooter } from '../../components/layout/site-footer'
import { headerItems } from '../../components/layout/site-links'
import { getRoute } from '../routing/routes'
import { canonicalPathname } from './canonical-url'
import { generateBaseMetadata, registeredRoute } from './seo-config'
import {
  createBestPagesSitemapResponse,
  createCanonicalRobots,
  createPagesSitemapResponse,
  createSitemapIndexResponse,
  createTagsSitemapResponse
} from './sitemaps'
import { isBestPageIndexable, isTagIndexable } from './taxonomy-indexing'

const origin = 'https://best.serp.co'
const staticRoutes = siteRoutes.filter(route => !route.path.includes('['))

/** A catalog with something in every taxonomy index, so the pages sitemap lists them all. */
const tags = [
  { count: 12, lastModifiedAt: '2026-09-01T00:00:00.000Z', slug: 'ai-writing' },
  { count: 4, lastModifiedAt: '2026-09-02T00:00:00.000Z', slug: 'ai-summaries' },
  { count: 30, lastModifiedAt: '2026-09-03T00:00:00.000Z', slug: 'ai-chatbots' }
]
const bestPages = [
  {
    category: null,
    lastModifiedAt: '2026-09-04T00:00:00.000Z',
    listSize: 10,
    poolSize: 30,
    slug: 'ai-chatbot',
    tag: 'ai-chatbots'
  },
  {
    category: 'writing',
    lastModifiedAt: '2026-09-05T00:00:00.000Z',
    listSize: 10,
    poolSize: 3,
    slug: 'ai-summarizer',
    tag: 'ai-summaries'
  }
]
const loaders = { getBestPages: () => bestPages, getTags: () => tags, getWebsites: () => [] }

function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1] ?? '')
}

function pathOf(location: string): string {
  return location === origin ? '/' : new URL(location).pathname
}

beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the route registry (#167)', () => {
  it('lists each canonical path once', () => {
    const paths = siteRoutes.map(route => route.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) expect(canonicalPathname(path), path).toBe(path)
  })

  it('gives a sitemap only to indexable, crawlable, self-canonical routes', () => {
    for (const route of siteRoutes) {
      const crawlable = !('disallow' in route && route.disallow)
      const selfCanonical = !('canonicalPath' in route)
      if (route.sitemapGroup) {
        expect(route.indexable && crawlable && selfCanonical, route.path).toBe(true)
      }
      if (route.indexable && crawlable && selfCanonical) {
        expect(route.sitemapGroup, `${route.path} is indexable but in no sitemap`).not.toBeNull()
      }
      if (!crawlable) expect(route.indexable, route.path).toBe(false)
    }
  })

  it('the pages sitemap lists exactly its static pages, in canonical form', async () => {
    const listed = locations(await (await createPagesSitemapResponse(loaders)).text()).map(pathOf)
    expect(listed).toEqual(
      staticRoutes.filter(route => route.sitemapGroup === 'pages').map(route => route.path)
    )
  })

  it('the index lists exactly the child sitemaps, and robots.txt names the index', async () => {
    expect(locations(await (await createSitemapIndexResponse(loaders)).text()).map(pathOf)).toEqual(
      [
        sitemapPaths.pages,
        sitemapPaths.products,
        sitemapPaths.categories,
        sitemapPaths.tags,
        sitemapPaths.best
      ]
    )
    expect(createCanonicalRobots().sitemap).toBe(`${origin}${SITEMAP_INDEX_PATH}`)
  })

  // One predicate, two consumers (#341, design 2.3): a tag or best page is in its sitemap exactly
  // when its page renders `index` (the pages call the same predicates for their metadata).
  it('lists a tag or best page in its sitemap exactly when the page is indexable', async () => {
    const listedTags = locations(await (await createTagsSitemapResponse(loaders)).text())
    for (const tag of tags) {
      expect(
        listedTags.includes(`${origin}${getRoute('tag.page', { tag: tag.slug })}`),
        tag.slug
      ).toBe(isTagIndexable(tag, bestPages))
    }
    const listedBest = locations(await (await createBestPagesSitemapResponse(loaders)).text())
    for (const page of bestPages) {
      expect(
        listedBest.includes(`${origin}${getRoute('best.page', { keyword: page.slug })}`),
        page.slug
      ).toBe(isBestPageIndexable(page))
    }
    expect(listedTags).toEqual([`${origin}/products/tags/ai-writing/`])
    expect(listedBest).toEqual([`${origin}/best/ai-chatbot/`])
  })

  // #346: `scripts/site-routes.ts` (the publisher's affected routes) reads the registry too.
  it('gives the scripts, getRoute and the registry one set of taxonomy routes and sitemaps', () => {
    expect(tagIndexRoute()).toBe(getRoute('tag.index'))
    expect(tagRoute('ai-chatbots')).toBe(getRoute('tag.page', { tag: 'ai-chatbots' }))
    expect(bestIndexRoute()).toBe(getRoute('best.index'))
    expect(bestRoute('ai-chatbot')).toBe(getRoute('best.page', { keyword: 'ai-chatbot' }))
    expect([tagIndexRoute(), tagRoute('x'), bestIndexRoute(), bestRoute('x')]).toEqual([
      '/products/tags/',
      '/products/tags/x/',
      '/best/',
      '/best/x/'
    ])
    const registered = siteRoutes.map(route => route.path)
    for (const path of Object.values(taxonomyRoutePaths)) expect(registered).toContain(path)
    // Tag pages sit beside the category pages, under the listing base path.
    expect(taxonomyRoutePaths.tagIndex.startsWith(`/${site.routes.listingBasePath}/`)).toBe(true)
    expect(catalogSitemapRoutes({ taxonomy: true }).slice(-2)).toEqual([
      sitemapPaths.tags,
      sitemapPaths.best
    ])
    expect(catalogSitemapRoutes()).not.toContain(sitemapPaths.tags)
  })

  it('reserves the listing slugs of the registry pages under /products/', () => {
    expect([...reservedListingSlugs].sort()).toEqual(['categories', 'tags'])
    expect(isReservedListingSlug('tags')).toBe(true)
    expect(isReservedListingSlug('autoenhance.ai')).toBe(false)
  })

  it('robots.txt disallows exactly the disallowed routes, and nothing a sitemap lists', () => {
    const disallow = createCanonicalRobots().rules
    const values = (Array.isArray(disallow) ? [] : [disallow.disallow].flat()).filter(
      (value): value is string => typeof value === 'string'
    )
    expect(values).toEqual(['/search', '/submit'])
    for (const route of siteRoutes) {
      if (!route.sitemapGroup) continue
      expect(
        values.some(prefix => route.path.startsWith(prefix)),
        route.path
      ).toBe(false)
    }
  })

  it('page metadata takes its robots directive and canonical from the registry', () => {
    for (const route of staticRoutes) {
      const metadata = generateBaseMetadata({ description: 'd', path: route.path, title: 't' })
      const robots = metadata.robots as { index?: boolean }
      expect(robots.index !== false, route.path).toBe(route.indexable)
      const canonical = 'canonicalPath' in route ? route.canonicalPath : route.path
      expect(metadata.alternates?.canonical, route.path).toBe(
        canonical === '/' ? origin : `${origin}${canonical}`
      )
    }
    // An explicit noindex still wins, for a feature-disabled route.
    const disabled = generateBaseMetadata({
      description: 'd',
      noindex: true,
      path: '/',
      title: 't'
    })
    expect((disabled.robots as { index?: boolean }).index).toBe(false)
  })

  it('the footer links only registered pages', () => {
    const html = renderToStaticMarkup(<SiteFooter />)
    const internal = [...html.matchAll(/\shref="(\/[^"#?]*)"/gu)].map(match => match[1] ?? '')
    expect(internal.length).toBeGreaterThan(0)
    for (const href of internal) {
      if (href.endsWith('.xml') || href.endsWith('.svg')) continue
      expect(registeredRoute(href), href).toBeDefined()
    }
  })

  it('the header links only registered pages', () => {
    const hrefs = headerItems({ bestIndexListed: true }).flatMap(item =>
      item.kind === 'link' ? [item.link.href] : item.links.map(link => link.href)
    )
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(registeredRoute(href), href).toBeDefined()
  })
})
