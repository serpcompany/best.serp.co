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
  {
    category: 'video-downloaders',
    modifiedAt: '2026-09-30T12:00:00.000Z',
    publishedAt: '2026-05-16',
    slug: 'autoenhance.ai'
  },
  // The catch-all category is a page like any other, so its sitemap lists it.
  { category: 'other', publishedAt: '2026-05-17', slug: 'example-product' }
]
const loaders = { getWebsites: () => websites }

function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1] ?? '')
}

describe('sitemaps and absolute URLs', () => {
  it('lists the homepage as the bare origin and every other page with a slash', async () => {
    const pages = locations(await (await createPagesSitemapResponse(loaders)).text())
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
    expect(locations(await (await createSitemapIndexResponse(loaders)).text())).toEqual([
      `${origin}/sitemap-pages.xml`,
      `${origin}/sitemap-products.xml`,
      `${origin}/sitemap-categories.xml`
    ])
  })

  it('takes lastmod from D1, and writes none for a page whose content is code (#218)', async () => {
    const entries = (xml: string) =>
      Object.fromEntries(
        [...xml.matchAll(/<loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/gu)].map(match => [
          match[1],
          match[2]
        ])
      )
    // A listing's modifiedAt, or its publication date when it never changed.
    expect(entries(await (await createListingsSitemapResponse(loaders)).text())).toEqual({
      [`${origin}/products/autoenhance.ai/`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/products/example-product/`]: '2026-05-17T00:00:00.000Z'
    })
    // A category's newest listing.
    expect(entries(await (await createTaxonomiesSitemapResponse(loaders)).text())).toEqual({
      [`${origin}/products/categories/other/`]: '2026-05-17T00:00:00.000Z',
      [`${origin}/products/categories/video-downloaders/`]: '2026-09-30T12:00:00.000Z'
    })
    // The catalog pages carry the newest listing; the others none.
    const pages = entries(await (await createPagesSitemapResponse(loaders)).text())
    expect(pages[origin]).toBe('2026-09-30T12:00:00.000Z')
    expect(pages[`${origin}/products/categories/`]).toBe('2026-09-30T12:00:00.000Z')
    expect(pages[`${origin}/about/`]).toBeUndefined()
    // Each index entry carries its newest child.
    expect(entries(await (await createSitemapIndexResponse(loaders)).text())).toEqual({
      [`${origin}/sitemap-categories.xml`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/sitemap-pages.xml`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/sitemap-products.xml`]: '2026-09-30T12:00:00.000Z'
    })
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
