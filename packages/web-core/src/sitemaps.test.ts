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
  { category: 'video-downloaders', publishedAt: '2026-05-17', slug: 'example-product' }
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
    expect(categories).toEqual([`${origin}/products/categories/video-downloaders/`])
  })

  it('points robots.txt and the index at unslashed sitemap files', async () => {
    expect(createCanonicalRobots().sitemap).toBe(`${origin}/sitemap-index.xml`)
    expect(
      locations(await createSitemapIndexResponse({ getWebsites: () => websites }).text())
    ).toEqual([
      `${origin}/sitemaps/pages/1.xml`,
      `${origin}/sitemaps/directory/1.xml`,
      `${origin}/sitemaps/categories/1.xml`
    ])
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
