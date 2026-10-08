import { describe, expect, it } from 'vitest'
import { generateBreadcrumbSchema, siteUrl } from './seo-config'
import {
  createCanonicalRobots,
  createListingsSitemapResponse,
  createPagesSitemapResponse,
  createSitemapIndexResponse,
  createTaxonomiesSitemapResponse
} from './sitemaps'

const origin = 'https://best.serp.co'
const websites = [
  { category: 'video-downloaders', publishedAt: '2026-05-16', slug: 'autoenhance.ai' },
  // The catch-all category is a page like any other, so its sitemap lists it.
  { category: 'other', publishedAt: '2026-05-17', slug: 'example-product' }
]

function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1] ?? '')
}

describe('sitemaps and absolute URLs', () => {
  it('lists the homepage as the bare origin and every other page with a slash', async () => {
    const pages = locations(await createPagesSitemapResponse().text())
    expect(pages[0]).toBe(origin)
    expect(pages).not.toContain(`${origin}/`)
    for (const location of pages.slice(1)) {
      expect(location).toMatch(/^https:\/\/best\.serp\.co\/.+\/$/u)
    }
    expect(pages).toContain(`${origin}/about/`)
    expect(pages).toContain(`${origin}/products/categories/`)
  })

  it('keeps listing and category URLs, including domain-name slugs, slashed', async () => {
    const listings = locations(
      await (await createListingsSitemapResponse({ getWebsites: () => websites })).text()
    )
    expect(listings).toEqual([
      `${origin}/products/autoenhance.ai/`,
      `${origin}/products/example-product/`
    ])
    const categories = locations(
      await (await createTaxonomiesSitemapResponse({ getWebsites: () => websites })).text()
    )
    expect(categories).toEqual([
      `${origin}/products/categories/other/`,
      `${origin}/products/categories/video-downloaders/`
    ])
  })

  it('points robots.txt and the index at the root-level sitemap files (#167)', async () => {
    expect(createCanonicalRobots().sitemap).toBe(`${origin}/sitemap-index.xml`)
    expect(locations(await createSitemapIndexResponse().text())).toEqual([
      `${origin}/sitemap-pages.xml`,
      `${origin}/sitemap-products.xml`,
      `${origin}/sitemap-categories.xml`
    ])
  })

  it('writes no lastmod it cannot back with data', async () => {
    const pages = await createPagesSitemapResponse().text()
    const index = await createSitemapIndexResponse().text()
    const categories = await (
      await createTaxonomiesSitemapResponse({ getWebsites: () => websites })
    ).text()
    for (const xml of [pages, index, categories]) expect(xml).not.toContain('<lastmod>')
    const listings = await (
      await createListingsSitemapResponse({ getWebsites: () => websites })
    ).text()
    expect(listings).toContain('<lastmod>2026-05-16T00:00:00.000Z</lastmod>')
  })

  it('writes the homepage as the bare origin in structured data', () => {
    expect(siteUrl('/')).toBe(origin)
    expect(siteUrl('/about')).toBe(`${origin}/about/`)
    expect(
      generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'About', url: '/about/' }
      ]).itemListElement.map(item => item.item)
    ).toEqual([origin, `${origin}/about/`])
  })
})
