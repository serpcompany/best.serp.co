import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1, seedContractFixture } from '@/db/test-support'
import { LISTING_CONTENT_FORMAT } from '@/lib/markdown/listing-content'
import { REVIEW_BODY } from '@/lib/markdown/listing-content-test-support'
import { listingContentTree } from '@/lib/markdown/listing-content-tree'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))

const { getCategoryListings, getListingBySlug, getSitemapListingPage, getSitemapListingPageCount } =
  await import('./repository')

/** A Workers Cache API stand-in: entries by request URL, kept as the JSON the data cache writes. */
class MemoryCache {
  readonly entries = new Map<string, string>()

  async match(request: Request): Promise<Response | undefined> {
    const body = this.entries.get(request.url)
    return body === undefined ? undefined : new Response(body)
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, await response.text())
  }
}

describe('the catalog adapter’s listing detail (#334)', () => {
  let sqlite: SqliteD1
  let cache: MemoryCache
  const logs: Array<Record<string, unknown>> = []

  beforeEach(() => {
    sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    sqlite.database
      .prepare("UPDATE listings SET content = ? WHERE slug = 'charlie'")
      .run(REVIEW_BODY)
    getCloudflareContext.mockResolvedValue({
      env: { D1_RUNTIME_ENV: 'local', DB: sqlite.asD1Database(), MEDIA_BASE_URL: '/_media' }
    })
    cache = new MemoryCache()
    vi.stubGlobal('caches', { open: async () => cache })
    logs.length = 0
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
      logs.push(JSON.parse(String(line)))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const contentEvents = () =>
    logs.filter(log => log.event === 'catalog_cache' && log.operation === 'listing-content')

  it('attaches the body’s tree, so the page renders it instead of parsing the body', async () => {
    const detail = await getListingBySlug('charlie')
    // charlie lists resource links, so the body's own "Links" section is left out.
    expect(detail?.resourceLinks?.length).toBeGreaterThan(0)
    expect(detail?.contentTree).toEqual(listingContentTree(REVIEW_BODY, true))
    expect(contentEvents().map(log => log.state)).toEqual(['miss', 'written'])
    const keys = [...cache.entries.keys()].map(url => decodeURIComponent(url))
    expect(keys.filter(key => key.includes(':charlie'))).toContainEqual(
      expect.stringContaining(`catalog-listing-content:`)
    )
    expect(keys.some(key => key.endsWith(`:${LISTING_CONTENT_FORMAT}:charlie`))).toBe(true)
  })

  it('reads the tree back from the data cache on the next uncached render', async () => {
    const first = await getListingBySlug('charlie')
    logs.length = 0
    const second = await getListingBySlug('charlie')
    expect(second?.contentTree).toBeDefined()
    expect(second?.contentTree).toEqual(first?.contentTree)
    expect(contentEvents().map(log => log.state)).toEqual(['hit'])
  })

  it('attaches no tree to a listing without a body', async () => {
    sqlite.database.prepare("UPDATE listings SET content = NULL WHERE slug = 'charlie'").run()
    const detail = await getListingBySlug('charlie')
    expect(detail?.slug).toBe('charlie')
    expect(detail && 'contentTree' in detail).toBe(false)
    expect(contentEvents()).toEqual([])
  })
})

// #397: staging and production are custom domains in one zone, whose cache both Workers share.
describe('the catalog adapter’s data cache scope (#397)', () => {
  let sqlite: SqliteD1
  let zone: MemoryCache
  const logs: Array<Record<string, unknown>> = []

  beforeEach(() => {
    sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    zone = new MemoryCache()
    vi.stubGlobal('caches', { open: async () => zone })
    logs.length = 0
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
      logs.push(JSON.parse(String(line)))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Serves the next renders as `name`'s Worker, over the same catalog (so the same keys). */
  const servedAs = (name: string | undefined) =>
    getCloudflareContext.mockResolvedValue({
      env: {
        D1_RUNTIME_ENV: name,
        DB: sqlite.asD1Database(),
        MEDIA_BASE_URL: 'https://cdn.serp.co'
      }
    })
  const detailStates = () =>
    logs
      .filter(log => log.event === 'catalog_cache' && log.operation === 'listing-detail')
      .map(log => log.state)
  const keysIn = (environment: string) =>
    [...zone.entries.keys()]
      .filter(url => url.startsWith(`https://catalog-data-ops.invalid/${environment}/`))
      .map(url => url.slice(`https://catalog-data-ops.invalid/${environment}/`.length))
      .sort()

  it('never reads an entry another environment wrote under the same epoch and key', async () => {
    servedAs('staging')
    await getListingBySlug('charlie')
    expect(detailStates()).toEqual(['miss', 'written'])

    logs.length = 0
    servedAs('production')
    await getListingBySlug('charlie')
    expect(detailStates()).toEqual(['miss', 'written'])
    logs.length = 0
    await getListingBySlug('charlie')
    expect(detailStates()).toEqual(['hit'])

    // Each environment holds the same keys, and no entry sits outside an environment.
    expect(keysIn('staging').length).toBeGreaterThan(0)
    expect(keysIn('production')).toEqual(keysIn('staging'))
    expect(zone.entries.size).toBe(keysIn('staging').length * 2)
  })

  it.each([undefined, '', 'preview'])(
    'reads and writes no entry with environment %o',
    async name => {
      servedAs(name)
      await expect(getListingBySlug('charlie')).rejects.toMatchObject({
        code: 'd1_runtime_env_invalid'
      })
      expect(zone.entries.size).toBe(0)
      expect(logs.filter(log => log.event === 'catalog_cache')).toEqual([])
    }
  )
})

describe('the catalog adapter’s HTML sitemap and alternatives reads (#53)', () => {
  let cache: MemoryCache
  const logs: Array<Record<string, unknown>> = []

  beforeEach(() => {
    const sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    getCloudflareContext.mockResolvedValue({
      env: { D1_RUNTIME_ENV: 'local', DB: sqlite.asD1Database(), MEDIA_BASE_URL: '/_media' }
    })
    cache = new MemoryCache()
    vi.stubGlobal('caches', { open: async () => cache })
    logs.length = 0
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
      logs.push(JSON.parse(String(line)))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const cacheStates = (operation: string) =>
    logs
      .filter(log => log.event === 'catalog_cache' && log.operation === operation)
      .map(log => log.state)

  it('lists every public listing oldest first, from the products sitemap’s cached list', async () => {
    expect(await getSitemapListingPage(1)).toEqual({
      // Publication order reversed; `future` is not public yet.
      items: ['echo', 'delta', 'charlie', 'bravo', 'alpha'].map(slug => ({
        name: `${slug} listing`,
        slug
      })),
      page: 1,
      pageCount: 1,
      total: 5
    })
    expect(await getSitemapListingPageCount()).toBe(1)
    expect(cacheStates('published-summaries')).toEqual(['miss', 'written', 'hit'])
  })

  it('has no page past the last', async () => {
    expect(await getSitemapListingPage(2)).toBeNull()
    expect(await getSitemapListingPage(0)).toBeNull()
  })

  it('reads a category’s first listings in directory order, cached like a list page', async () => {
    const alternatives = await getCategoryListings('secondary', 2)
    expect(alternatives.map(listing => listing.slug)).toEqual(['alpha', 'charlie'])
    expect((await getCategoryListings('primary', 6)).map(listing => listing.slug)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo'
    ])
    expect(cacheStates('listing-name-page')).toEqual(['miss', 'written', 'miss', 'written'])
    expect(await getCategoryListings('empty', 6)).toEqual([])
  })
})
