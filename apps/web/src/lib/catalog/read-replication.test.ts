import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noCatalogDataCache } from '@/db/cache'
import { createCatalogOperations } from '@/db/catalog'
import { createSessionDatabase } from '@/db/client'
import { type D1Copy, ReplicatedD1, seedContractFixture } from '@/db/test-support'
import { EDGE_CACHE_HEADER, withEdgeCache } from '@/lib/edge-cache/html-cache'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))

const { getActiveCategories, getListingBySlug } = await import('./repository')
const { catalogEpochReader, catalogRenderer } = await import('@/lib/worker/catalog')

/**
 * D1 read replication through the Sessions API (#382), end to end: the Worker entry reads the
 * catalog epoch for the edge cache key and keeps its bookmark (the isolate memo and the data
 * center's Cache API share), the render of a miss reads the catalog at that bookmark, and every
 * other render reads the primary. The database is `ReplicatedD1`: a primary and a replica that
 * can lag behind it.
 */

/** A Workers Cache API stand-in that keeps each response's body, headers and status. */
class MemoryCache {
  readonly entries = new Map<
    string,
    { body: string; headers: [string, string][]; status: number }
  >()

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.entries.get(new Request(request).url)
    return entry && new Response(entry.body, { headers: entry.headers, status: entry.status })
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(new Request(request).url, {
      body: await response.text(),
      headers: [...response.headers],
      status: response.status
    })
  }
}

/** One data center's caches: the edge HTML cache (and the epoch share) and the data cache. */
function dataCenter() {
  return { data: new MemoryCache(), edge: new MemoryCache() }
}

const RENAMED = 'charlie renamed'
/** A publication: charlie's new name and the publication version it advances. */
const PUBLICATION = `UPDATE listings SET name = '${RENAMED}' WHERE slug = 'charlie';
  UPDATE publication_state SET version = version + 1 WHERE id = 1;`

let db: ReplicatedD1
let caches: ReturnType<typeof dataCenter>
const background: Promise<unknown>[] = []
const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise) }
const observe = () => {}

/**
 * One isolate's Worker: the edge cache in front of a page that renders a listing's name, or (on
 * `/account/`, as the account pages do) the active categories, through the catalog adapter.
 */
function isolate(nearest: D1Copy) {
  const env = { D1_RUNTIME_ENV: 'local', DB: db.binding(nearest), MEDIA_BASE_URL: '/_media' }
  const render = catalogRenderer(
    env,
    async rendered => {
      const { pathname } = new URL(rendered.url)
      if (pathname === '/account/') {
        return new Response((await getActiveCategories()).map(category => category.slug).join())
      }
      const detail = await getListingBySlug(pathname.split('/')[2] ?? '')
      return new Response(detail?.name ?? 'missing', { status: detail ? 200 : 404 })
    },
    observe
  )
  return async (path: string, init?: RequestInit) => {
    getCloudflareContext.mockResolvedValue({ env })
    vi.stubGlobal('caches', { open: async () => caches.data })
    const response = await withEdgeCache(
      new Request(`https://best.serp.co${path}`, init),
      context,
      {
        cache: caches.edge as unknown as Cache,
        deploymentId: 'v1',
        epoch: catalogEpochReader(env, caches.edge as unknown as Cache, observe)
      },
      render
    )
    await Promise.all(background.splice(0))
    return { state: response.headers.get(EDGE_CACHE_HEADER), text: await response.text() }
  }
}

/** What the data cache stored for a listing's detail, by the epoch version in its key. */
function cachedDetailNames(slug: string): Record<string, string> {
  const names: Record<string, string> = {}
  for (const [url, entry] of caches.data.entries) {
    const key = decodeURIComponent(url)
    const match = /catalog-detail:[^:]+:(\d+)\.[^/]*:(.+)$/u.exec(key)
    if (match?.[2] !== slug) continue
    names[match[1] as string] = (JSON.parse(entry.body) as { detail: { name: string } }).detail.name
  }
  return names
}

/** The copies a step's statements went to. */
function servedDuring(step: () => Promise<unknown>): Promise<D1Copy[]> {
  const before = db.served.length
  return step().then(() => db.served.slice(before))
}

beforeEach(() => {
  db = new ReplicatedD1()
  db.seed(seedContractFixture)
  caches = dataCenter()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('D1 read replication (#382)', () => {
  it('never caches rows from a lagging replica under a newer epoch', async () => {
    db.write(PUBLICATION)
    // A Worker whose nearest copy is a replica that still lacks the publication. Its epoch read
    // starts on the primary (epoch 2), and its render at that read's bookmark, so the replica
    // (older than the bookmark) is passed over for the primary.
    const nearReplica = isolate('replica')
    const served = await servedDuring(async () => {
      expect(await nearReplica('/products/charlie/')).toEqual({ state: 'MISS', text: RENAMED })
    })
    expect(db.sessions).toEqual(['first-primary', '00000002'])
    expect(served.length).toBeGreaterThan(0)
    expect(served.every(copy => copy === 'primary')).toBe(true)
    expect(cachedDetailNames('charlie')).toEqual({ '2': RENAMED })

    // Another isolate in that data center reuses the shared epoch and its bookmark: no epoch
    // read, and its render starts at the same bookmark.
    const sameDataCenter = isolate('replica')
    const sharedServed = await servedDuring(async () => {
      expect(await sameDataCenter('/products/delta/')).toEqual({
        state: 'MISS',
        text: 'delta listing'
      })
    })
    expect(db.sessions).toEqual(['first-primary', '00000002', '00000002'])
    expect(sharedServed.every(copy => copy === 'primary')).toBe(true)
  })

  it('would cache the replica’s older rows under that epoch without the bookmark', async () => {
    // The hazard the bookmark prevents: the same read, at epoch 2, through a session that
    // starts anywhere, gets the replica's charlie from before the publication.
    db.write(PUBLICATION)
    const unconstrained = createCatalogOperations({
      cache: noCatalogDataCache,
      client: createSessionDatabase(db.binding('replica').withSession('first-unconstrained')),
      clock: () => new Date(),
      observe,
      reuseEpoch: () => ({ effectiveAt: '2026-07-05T00:00:00.000Z', version: 2 })
    })
    expect((await unconstrained.getListingBySlug('charlie'))?.name).toBe('charlie listing')
  })

  it('reads the nearest replica once it is as new as the epoch, in one round trip', async () => {
    db.write(PUBLICATION)
    db.catchUp()
    const nearReplica = isolate('replica')
    const served = await servedDuring(async () => {
      expect(await nearReplica('/products/charlie/')).toEqual({ state: 'MISS', text: RENAMED })
    })
    // The epoch read on the primary, then the listing's one batch (#378) on the replica.
    expect(served).toEqual(['primary', 'replica', 'replica', 'replica', 'replica'])
    expect(db.primary.roundTrips).toEqual([
      { kind: 'statement', sql: expect.stringContaining('publication_state') }
    ])
    expect(db.replica.roundTrips).toEqual([{ kind: 'batch', size: 4 }])
    expect(cachedDetailNames('charlie')).toEqual({ '2': RENAMED })
  })

  // #382 review: a bypassed render reads the primary but reuses the isolate's epoch, so that
  // epoch must be the primary's too, or the data cache would hand a signed-in visitor the rows a
  // lagging replica gave an anonymous miss under its older epoch.
  it('shows signed-in visitors the primary’s data after a miss near a lagging replica', async () => {
    db.write(PUBLICATION)
    const nearReplica = isolate('replica')
    expect((await nearReplica('/products/charlie/')).state).toBe('MISS')
    const signedIn = { headers: { cookie: 'better-auth.session_token=a.b' } }
    expect(await nearReplica('/products/charlie/', signedIn)).toEqual({
      state: 'BYPASS',
      text: RENAMED
    })

    // A newer publication the replica also lacks reaches signed-in pages once the isolate's
    // shared epoch ages out (30 seconds), as before #382: the render reads its own epoch, on the
    // primary.
    db.write(`UPDATE listings SET name = 'charlie again' WHERE slug = 'charlie';
      UPDATE publication_state SET version = version + 1 WHERE id = 1;`)
    const later = Date.now() + 31_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(await nearReplica('/products/charlie/', signedIn)).toEqual({
      state: 'BYPASS',
      text: 'charlie again'
    })
    expect(Object.keys(cachedDetailNames('charlie')).sort()).toEqual(['2', '3'])
  })

  it('reads the primary for signed-in and bypassed requests', async () => {
    db.write(PUBLICATION)
    const nearReplica = isolate('replica')
    const served = await servedDuring(async () => {
      expect(
        await nearReplica('/products/charlie/', {
          headers: { cookie: 'better-auth.session_token=a.b' }
        })
      ).toEqual({ state: 'BYPASS', text: RENAMED })
      expect(await nearReplica('/account/')).toEqual({
        state: 'BYPASS',
        text: 'primary,secondary,empty'
      })
      expect(await nearReplica('/products/charlie/', { method: 'POST' })).toMatchObject({
        state: 'BYPASS'
      })
    })
    expect(db.sessions).toEqual([])
    expect(served.length).toBeGreaterThan(0)
    expect(served.every(copy => copy === 'primary')).toBe(true)
  })

  it('reads the primary when the shared epoch has no bookmark (an older Worker version’s)', async () => {
    db.write(PUBLICATION)
    await caches.edge.put(
      'https://html-cache.invalid/catalog-epoch',
      new Response('2.2026-07-05T00:00:00.000Z', {
        headers: { 'cache-control': 'public, max-age=30' }
      })
    )
    const nearReplica = isolate('replica')
    const served = await servedDuring(async () => {
      expect(await nearReplica('/products/charlie/')).toEqual({ state: 'MISS', text: RENAMED })
    })
    expect(db.sessions).toEqual([])
    expect(served.every(copy => copy === 'primary')).toBe(true)
    expect(cachedDetailNames('charlie')).toEqual({ '2': RENAMED })
  })

  it('without replication, reads the primary in the same round trips as before', async () => {
    // With replication off, D1 sends every session statement to the primary.
    const withoutReplication = isolate('primary')
    expect(await withoutReplication('/products/charlie/')).toEqual({
      state: 'MISS',
      text: 'charlie listing'
    })
    expect(db.primary.roundTrips).toEqual([
      { kind: 'statement', sql: expect.stringContaining('publication_state') },
      { kind: 'batch', size: 4 }
    ])
    expect(db.replica.roundTrips).toEqual([])
    expect(await withoutReplication('/products/charlie/')).toEqual({
      state: 'HIT',
      text: 'charlie listing'
    })
  })
})
