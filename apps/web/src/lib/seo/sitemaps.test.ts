import { describe, expect, it } from 'vitest'
import { generateBreadcrumbSchema, siteUrl } from './seo-config'
import {
  createBestPagesSitemapResponse,
  createCanonicalRobots,
  createListingsSitemapResponse,
  createPagesSitemapResponse,
  createSitemapIndexResponse,
  createTagsSitemapResponse,
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
  // The transitional catch-all hub renders noindex, so its sitemap leaves it out (#341).
  { category: 'other', publishedAt: '2026-05-17', slug: 'example-product' },
  { category: 'writing', publishedAt: '2026-05-18', slug: 'example-writer' },
  // A secondary category counts too: it moves `writing`'s lastmod.
  {
    categories: ['video-downloaders', 'writing'],
    category: 'video-downloaders',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    publishedAt: '2026-05-01',
    slug: 'both-categories'
  }
]
/** Tags of each kind the sitemap tells apart (#341, design 2.3). */
const tags = [
  // Indexed: 10 listings and no best page ranks it alone.
  { count: 10, lastModifiedAt: '2026-09-01T00:00:00.000Z', slug: 'ai-writing' },
  // Linked from the tag index (3 or more), not indexed.
  { count: 9, lastModifiedAt: '2026-09-02T00:00:00.000Z', slug: 'ai-summaries' },
  // Indexable by size, but an indexable best page ranks it alone.
  { count: 40, lastModifiedAt: '2026-09-03T00:00:00.000Z', slug: 'ai-chatbots' },
  // Indexed: its best page ranks it within one category, which does not count.
  { count: 12, lastModifiedAt: '2026-09-04T00:00:00.000Z', slug: 'ai-seo' },
  // Not linked from the index.
  { count: 2, lastModifiedAt: '2026-10-01T00:00:00.000Z', slug: 'ai-tiny' }
]
const bestPages = [
  // Indexed: 10 entries.
  {
    category: null,
    lastModifiedAt: '2026-09-05T00:00:00.000Z',
    listSize: 10,
    poolSize: 40,
    slug: 'ai-chatbot',
    tag: 'ai-chatbots'
  },
  // Rendered, noindex: 4 entries.
  {
    category: 'marketing',
    lastModifiedAt: '2026-09-06T00:00:00.000Z',
    listSize: 10,
    poolSize: 4,
    slug: 'ai-seo-tools',
    tag: 'ai-seo'
  },
  // Indexed at exactly 5 entries (list size 5).
  {
    category: 'writing',
    lastModifiedAt: '2026-09-07T00:00:00.000Z',
    listSize: 5,
    poolSize: 30,
    slug: 'writing-tools',
    tag: null
  },
  // No entry: a 404, in neither sitemap nor the index.
  {
    category: null,
    lastModifiedAt: '2026-10-02T00:00:00.000Z',
    listSize: 10,
    poolSize: 0,
    slug: 'empty-page',
    tag: 'ai-tiny'
  }
]
const loaders = { getBestPages: () => bestPages, getTags: () => tags, getWebsites: () => websites }
const noTaxonomy = { getBestPages: () => [], getTags: () => [], getWebsites: () => websites }

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
      `${origin}/products/example-product/`,
      `${origin}/products/example-writer/`,
      `${origin}/products/both-categories/`
    ])
    const categories = locations(
      await (await createTaxonomiesSitemapResponse({ getWebsites: () => websites })).text()
    )
    expect(categories).toEqual([
      `${origin}/products/categories/video-downloaders/`,
      `${origin}/products/categories/writing/`
    ])
  })

  it('points robots.txt and the index at the root-level sitemap files (#167, #341)', async () => {
    expect(createCanonicalRobots().sitemap).toBe(`${origin}/sitemap-index.xml`)
    expect(locations(await (await createSitemapIndexResponse(loaders)).text())).toEqual([
      `${origin}/sitemap-pages.xml`,
      `${origin}/sitemap-products.xml`,
      `${origin}/sitemap-categories.xml`,
      `${origin}/sitemap-tags.xml`,
      `${origin}/sitemap-best.xml`
    ])
    // The taxonomy's sitemaps are in the index before there is a tag or best page (#346).
    expect(locations(await (await createSitemapIndexResponse(noTaxonomy)).text())).toHaveLength(5)
  })

  it('lists exactly the indexable tags and best pages (#341, design 2.3)', async () => {
    expect(locations(await (await createTagsSitemapResponse(loaders)).text())).toEqual([
      `${origin}/products/tags/ai-seo/`,
      `${origin}/products/tags/ai-writing/`
    ])
    expect(locations(await (await createBestPagesSitemapResponse(loaders)).text())).toEqual([
      `${origin}/best/ai-chatbot/`,
      `${origin}/best/writing-tools/`
    ])
    // Empty until the taxonomy is published: a valid, empty urlset.
    for (const response of [
      await createTagsSitemapResponse(noTaxonomy),
      await createBestPagesSitemapResponse(noTaxonomy)
    ]) {
      const xml = await response.text()
      expect(xml).toContain('<urlset')
      expect(locations(xml)).toEqual([])
    }
  })

  it('lists the taxonomy indexes in the pages sitemap only while they list something (#341)', async () => {
    const pages = locations(await (await createPagesSitemapResponse(loaders)).text())
    expect(pages).toContain(`${origin}/products/tags/`)
    expect(pages).toContain(`${origin}/best/`)
    const before = locations(await (await createPagesSitemapResponse(noTaxonomy)).text())
    expect(before).not.toContain(`${origin}/products/tags/`)
    expect(before).not.toContain(`${origin}/best/`)
    // Only unlinked tags (fewer than 3 listings) and empty best pages: still a 404.
    const unlisted = locations(
      await (
        await createPagesSitemapResponse({
          ...noTaxonomy,
          getBestPages: () => bestPages.filter(page => page.poolSize === 0),
          getTags: () => tags.filter(tag => tag.count < 3)
        })
      ).text()
    )
    expect(unlisted).not.toContain(`${origin}/products/tags/`)
    expect(unlisted).not.toContain(`${origin}/best/`)
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
      [`${origin}/products/both-categories/`]: '2026-08-01T00:00:00.000Z',
      [`${origin}/products/example-product/`]: '2026-05-17T00:00:00.000Z',
      [`${origin}/products/example-writer/`]: '2026-05-18T00:00:00.000Z'
    })
    // A category's newest listing, its secondary listings included.
    expect(entries(await (await createTaxonomiesSitemapResponse(loaders)).text())).toEqual({
      [`${origin}/products/categories/video-downloaders/`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/products/categories/writing/`]: '2026-08-01T00:00:00.000Z'
    })
    // A tag's newest listing; a best page's later of its own change and its pool's (#341).
    expect(entries(await (await createTagsSitemapResponse(loaders)).text())).toEqual({
      [`${origin}/products/tags/ai-seo/`]: '2026-09-04T00:00:00.000Z',
      [`${origin}/products/tags/ai-writing/`]: '2026-09-01T00:00:00.000Z'
    })
    expect(entries(await (await createBestPagesSitemapResponse(loaders)).text())).toEqual({
      [`${origin}/best/ai-chatbot/`]: '2026-09-05T00:00:00.000Z',
      [`${origin}/best/writing-tools/`]: '2026-09-07T00:00:00.000Z'
    })
    // The catalog pages carry the newest listing, the taxonomy indexes their newest entry (only
    // what they list: not the unlinked tag or the empty best page); the others none.
    const pages = entries(await (await createPagesSitemapResponse(loaders)).text())
    expect(pages[origin]).toBe('2026-09-30T12:00:00.000Z')
    expect(pages[`${origin}/products/categories/`]).toBe('2026-09-30T12:00:00.000Z')
    expect(pages[`${origin}/products/tags/`]).toBe('2026-09-04T00:00:00.000Z')
    expect(pages[`${origin}/best/`]).toBe('2026-09-07T00:00:00.000Z')
    expect(pages[`${origin}/about/`]).toBeUndefined()
    // Each index entry carries its newest child.
    expect(entries(await (await createSitemapIndexResponse(loaders)).text())).toEqual({
      [`${origin}/sitemap-best.xml`]: '2026-09-07T00:00:00.000Z',
      [`${origin}/sitemap-categories.xml`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/sitemap-pages.xml`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/sitemap-products.xml`]: '2026-09-30T12:00:00.000Z',
      [`${origin}/sitemap-tags.xml`]: '2026-09-04T00:00:00.000Z'
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
