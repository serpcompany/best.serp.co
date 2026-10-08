/**
 * The route registry (`@serpdirectory/site-config` `siteRoutes`, #167) against everything that
 * reads it: the sitemaps, robots.txt, page metadata, and the footer. The page modules' own
 * metadata is checked against it in `apps/web/lib/environment/noindex-sources.test.ts`.
 */
import { SITEMAP_INDEX_PATH, sitemapPaths, siteRoutes } from '@serpdirectory/site-config'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalPathname } from './canonical-url'
import { Footer } from './layout/footer'
import { generateBaseMetadata, registeredRoute } from './seo-config'
import {
  createCanonicalRobots,
  createPagesSitemapResponse,
  createSitemapIndexResponse
} from './sitemaps'

const origin = 'https://best.serp.co'
const staticRoutes = siteRoutes.filter(route => !route.path.includes('['))

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
    const listed = locations(await createPagesSitemapResponse().text()).map(pathOf)
    expect(listed).toEqual(
      staticRoutes.filter(route => route.sitemapGroup === 'pages').map(route => route.path)
    )
  })

  it('the index lists exactly the child sitemaps, and robots.txt names the index', async () => {
    expect(locations(await createSitemapIndexResponse().text()).map(pathOf)).toEqual([
      sitemapPaths.pages,
      sitemapPaths.products,
      sitemapPaths.categories
    ])
    expect(createCanonicalRobots().sitemap).toBe(`${origin}${SITEMAP_INDEX_PATH}`)
  })

  it('robots.txt disallows exactly the disallowed routes, and nothing a sitemap lists', () => {
    const disallow = createCanonicalRobots().rules
    const values = Array.isArray(disallow) ? [] : [disallow.disallow].flat()
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
    const html = renderToStaticMarkup(<Footer />)
    const internal = [...html.matchAll(/\shref="(\/[^"#?]*)"/gu)].map(match => match[1] ?? '')
    expect(internal.length).toBeGreaterThan(0)
    for (const href of internal) {
      if (href.endsWith('.xml') || href.endsWith('.svg')) continue
      expect(registeredRoute(href), href).toBeDefined()
    }
  })
})
