import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1, seedContractFixture } from '@/db/test-support'
import { LISTING_CONTENT_FORMAT } from '@/lib/markdown/listing-content'
import { REVIEW_BODY } from '@/lib/markdown/listing-content-test-support'
import { listingContentTree } from '@/lib/markdown/listing-content-tree'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))

const { getListingBySlug } = await import('./repository')

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
