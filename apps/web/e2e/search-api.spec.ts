import { expect } from '@playwright/test'
import { seedFacts, seedListings, seedTags } from './seed-facts'
import { listingPath } from './site-fixture'
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

test.describe('search page', () => {
  test('shows the listings the API matched by a tag name, and none for a query nothing matches', async ({
    page
  }) => {
    // Neither listing's own name, description or slug holds the tag's name (#432).
    const tag = seedTags.whiteboards
    await page.goto(`/search/?q=${encodeURIComponent(tag.name)}`)
    for (const listing of [seedListings.claimable, seedListings.noLogo]) {
      await expect(
        page.locator(`main a[href="${listingPath(listing.slug)}"]`).first()
      ).toBeVisible()
    }
    await page.goto('/search/?q=fixture-nothing-matches')
    await expect(page.getByRole('heading', { name: 'Nothing Found' })).toBeVisible()
  })

  test('logs nothing for a search the visitor leaves mid-flight (#440, #442)', async ({ page }) => {
    // Hold the page's search until the visitor has left, so leaving cancels it. Chromium fires
    // `pagehide` before it rejects the cancelled fetch, which is what keeps the page from
    // reporting it; the console-error fixture fails this test on a `search_failed`.
    let leave = () => {}
    const left = new Promise<void>(resolve => {
      leave = resolve
    })
    await page.route(
      url => url.pathname === '/api/search',
      async route => {
        await left
        // The page that sent it is gone, so the route may already be closed.
        await route.continue().catch(() => undefined)
      }
    )
    const query = seedFacts.search.query
    const searching = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/search' && url.searchParams.get('q') === query
    })
    const cancelled = page.waitForEvent('requestfailed', request => {
      return new URL(request.url()).pathname === '/api/search'
    })
    await page.goto(`/search/?q=${encodeURIComponent(query)}`)
    await searching

    await page.goto('/')
    leave()
    // The browser cancelled the search rather than the test answering it.
    expect((await cancelled).failure()?.errorText).toBe('net::ERR_ABORTED')
  })
})
