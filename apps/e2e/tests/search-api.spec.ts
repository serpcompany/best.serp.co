import { expect, test } from '@playwright/test'

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
    const response = await request.get('/api/search?q=video%20downloader&limit=5')
    expect(response.status()).toBe(200)
    const results = (await response.json()) as Array<{ slug: string; url: string }>
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
    for (const result of results) expect(result.url).toBe(`/products/${result.slug}/`)
    expect(await (await request.get('/api/search?q=%20%20')).json()).toEqual([])
    // A domain finds its listing through the slug and the website host (owner decision, #81).
    const domain = (await (await request.get('/api/search?q=jasper.ai&limit=5')).json()) as Array<{
      slug: string
    }>
    expect(domain[0]?.slug).toBe('jasper.ai')
  })
})
