import { expect } from '@playwright/test'
import { seedFacts, seedListings } from './seed-facts'
import { test } from './test'

/**
 * `/api/search` against the real Worker and D1 (serpcompany/best.serp.co#77). Queries over D1's
 * 50-byte LIKE pattern limit or with many words used to answer 500; now every query is
 * normalized and capped, matched without LIKE, and answers 200 with at most 100 results.
 */
test.describe('search API', () => {
  test('answers long, many-word, non-ASCII, and odd queries with 200', async ({ request }) => {
    const queries = [
      'a'.repeat(200),
      `best ${'video downloader online free tool '.repeat(6)}`.slice(0, 200),
      Array.from({ length: 40 }, (_, index) => `word${index}`).join(' '),
      'the best free online video downloader for youtube',
      '视频下载器'.repeat(40),
      '🎬'.repeat(100),
      `%_\\'"; DROP TABLE listings; --`
    ]
    expect(queries[0]).toHaveLength(200)
    for (const query of queries) {
      const response = await request.get(`/api/search?q=${encodeURIComponent(query)}&limit=1000`)
      expect(response.status(), query.slice(0, 30)).toBe(200)
      const results = (await response.json()) as unknown[]
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeLessThanOrEqual(100)
    }
  })

  test('finds listings by name, description, or category within the limit', async ({ request }) => {
    // The seed's paginated category, by name: more matches than the limit.
    const category = seedFacts.paginatedCategory
    const response = await request.get(`/api/search?q=${encodeURIComponent(category.name)}&limit=5`)
    expect(response.status()).toBe(200)
    const results = (await response.json()) as Array<{
      category: string
      slug: string
      url: string
    }>
    expect(results).toHaveLength(5)
    for (const result of results) {
      expect(result.url).toBe(`/products/${result.slug}/`)
      expect(result.category).toBe(category.slug)
    }
    expect(await (await request.get('/api/search?q=%20%20')).json()).toEqual([])
    // A query that matches one listing's name finds exactly that listing.
    const named = (await (
      await request.get(`/api/search?q=${encodeURIComponent(seedFacts.search.query)}`)
    ).json()) as Array<{ slug: string }>
    expect(named.map(result => result.slug)).toEqual(
      seedFacts.search.listings.map(listing => listing.slug)
    )
    // A domain finds its listing through the slug and the website host (owner decision, #81).
    const host = seedListings.submitted.slug
    const domain = (await (
      await request.get(`/api/search?q=${encodeURIComponent(host)}&limit=5`)
    ).json()) as Array<{ slug: string }>
    expect(domain[0]?.slug).toBe(host)
  })
})
