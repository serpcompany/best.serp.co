import { beforeEach, describe, expect, it, vi } from 'vitest'

const epoch = vi.hoisted(() => ({
  isUnpublishedListingSlug: vi.fn(async () => true),
  readCatalogEpoch: vi.fn(async (options: { client: { database: string } }) => ({
    database: options.client.database
  })),
  shareCatalogEpochToken: vi.fn()
}))

vi.mock('@/db/catalog-epoch', async importOriginal => ({
  // The render's catalog read (`runWithCatalogRead`, #382) is the real one.
  ...(await importOriginal<typeof import('@/db/catalog-epoch')>()),
  catalogEpochToken: (value: { database: string }) => `epoch-of-${value.database}`,
  isUnpublishedListingSlug: epoch.isUnpublishedListingSlug,
  readCatalogEpoch: epoch.readCatalogEpoch,
  shareCatalogEpochToken: epoch.shareCatalogEpochToken
}))
vi.mock('@/db/client', () => ({
  createDatabase: (database: { name: string }) => ({ database: database.name, session: null }),
  createSessionDatabase: (session: { constraint: string; name: string }) => ({
    database: session.name,
    session: session.constraint
  })
}))

const { currentCatalogRead } = await import('@/db/catalog-epoch')
const { EPOCH_LOAD_TIMEOUT_MS } = await import('../edge-cache/html-cache')
const { catalogEpochReader, catalogRenderer } = await import('./catalog')

/** A `DB` binding whose sessions answer with a bookmark named after it. */
function binding(name: string): D1Database {
  return {
    name,
    withSession: vi.fn((constraint: string) => ({
      constraint,
      getBookmark: () => `bookmark-of-${name}`,
      name
    }))
  } as unknown as D1Database
}

function cache(): Cache {
  return {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined)
  } as unknown as Cache
}

const context = { waitUntil: () => {} }
const observe = () => {}

/** Whether `promise` has settled yet, and with what, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false }
  promise.then(
    value => {
      state.settled = true
      state.value = value
    },
    () => {
      state.settled = true
    }
  )
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('catalogEpochReader (#165)', () => {
  it('reads the epoch once per database binding and reuses it across requests', async () => {
    const database = binding('a')
    const first = catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, cache(), observe)
    const second = catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, cache(), observe)
    expect(await first(context)).toEqual({
      read: { bookmark: 'bookmark-of-a', token: 'epoch-of-a' },
      source: 'd1'
    })
    expect(await second(context)).toEqual({
      read: { bookmark: 'bookmark-of-a', token: 'epoch-of-a' },
      source: 'fresh'
    })
    expect(epoch.readCatalogEpoch).toHaveBeenCalledTimes(1)
    expect(epoch.shareCatalogEpochToken).toHaveBeenCalledWith('epoch-of-a')
  })

  // #382: the epoch read starts on the primary, so every shared epoch is the primary's (#382
  // review); its bookmark travels with the epoch.
  it('reads the epoch through a session that starts on the primary, and keeps its bookmark', async () => {
    const database = binding('replicated')
    const read = catalogEpochReader({ D1_RUNTIME_ENV: 'staging', DB: database }, cache(), observe)
    expect((await read(context)).read).toEqual({
      bookmark: 'bookmark-of-replicated',
      token: 'epoch-of-replicated'
    })
    expect(database.withSession).toHaveBeenCalledExactlyOnceWith('first-primary')
    expect(epoch.readCatalogEpoch).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { database: 'replicated', session: 'first-primary' }
      })
    )
  })

  it('never answers through a binding an earlier request saw', async () => {
    const before = catalogEpochReader(
      { D1_RUNTIME_ENV: 'staging', DB: binding('old') },
      cache(),
      observe
    )
    const after = catalogEpochReader(
      { D1_RUNTIME_ENV: 'staging', DB: binding('new') },
      cache(),
      observe
    )
    expect((await before(context)).read?.token).toBe('epoch-of-old')
    expect((await after(context)).read?.token).toBe('epoch-of-new')
  })

  // #443: a load runs in the request that needs it, through that request's own cache handle,
  // never one a later request handed over.
  it("loads through its own request's cache handle", async () => {
    const database = binding('own')
    const first = cache()
    const later = cache()
    const read = catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, first, observe)
    catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, later, observe)
    await read(context)
    expect(first.match).toHaveBeenCalled()
    expect(first.put).toHaveBeenCalled()
    expect(later.match).not.toHaveBeenCalled()
  })

  // #397: staging and production are custom domains in one zone, whose cache both Workers share.
  it("keys the data center's share of the epoch on the environment", async () => {
    const entries = new Map<string, string>()
    const zone = {
      match: async (key: string) => {
        const token = entries.get(key)
        return token === undefined ? undefined : new Response(token)
      },
      put: async (key: string, response: Response) => {
        entries.set(key, await response.text())
      }
    } as unknown as Cache
    const staging = { D1_RUNTIME_ENV: 'staging', DB: binding('staging-db') }
    const production = { D1_RUNTIME_ENV: 'production', DB: binding('production-db') }

    expect((await catalogEpochReader(staging, zone, observe)(context)).read).toEqual({
      bookmark: 'bookmark-of-staging-db',
      token: 'epoch-of-staging-db'
    })
    expect((await catalogEpochReader(production, zone, observe)(context)).read).toEqual({
      bookmark: 'bookmark-of-production-db',
      token: 'epoch-of-production-db'
    })
    expect(Object.fromEntries(entries)).toEqual({
      'https://html-cache.invalid/catalog-epoch/production': 'epoch-of-production-db',
      'https://html-cache.invalid/catalog-epoch/staging': 'epoch-of-staging-db'
    })
  })

  // #443: the isolate shared one in-flight epoch load, whose I/O ran in the request that started
  // it. When that request was canceled, the load never settled, and every later cacheable request
  // on the isolate waited on it until its own client gave up.
  it('lets no stuck epoch load hold another request, or itself past the timeout (#443)', async () => {
    vi.useFakeTimers()
    try {
      const env = { D1_RUNTIME_ENV: 'production', DB: binding('stuck') }
      const stuck = { bookmark: 'bookmark-of-stuck', token: 'epoch-of-stuck' }
      // The first request's epoch read never settles, as when its request is canceled mid-read.
      epoch.readCatalogEpoch.mockImplementationOnce(() => new Promise(() => {}))
      const first = track(catalogEpochReader(env, cache(), observe)(context))
      const concurrent = track(catalogEpochReader(env, cache(), observe)(context))
      await vi.advanceTimersByTimeAsync(0)
      // A concurrent request reads the epoch itself instead of waiting on the stuck load.
      expect(concurrent.settled).toBe(true)
      expect(first.settled).toBe(false)
      expect(concurrent.value).toEqual({ read: stuck, source: 'd1' })
      await vi.advanceTimersByTimeAsync(EPOCH_LOAD_TIMEOUT_MS)
      // The stuck request answers at the timeout with the value the concurrent one loaded.
      expect(first.settled).toBe(true)
      expect(first.value).toEqual({ ageMs: EPOCH_LOAD_TIMEOUT_MS, read: stuck, source: 'timeout' })
      const later = track(catalogEpochReader(env, cache(), observe)(context))
      await vi.advanceTimersByTimeAsync(0)
      expect(later.value).toEqual({ read: stuck, source: 'fresh' })
      expect(epoch.readCatalogEpoch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { D1_RUNTIME_ENV: 'local' },
    { D1_RUNTIME_ENV: 'preview', DB: binding('a') },
    { DB: binding('a') }
  ])('stays out of the way without a valid binding: %o', async env => {
    expect(await catalogEpochReader(env, cache(), observe)(context)).toEqual({ read: null })
    expect(epoch.readCatalogEpoch).not.toHaveBeenCalled()
  })
})

describe('catalogRenderer (#165)', () => {
  const notFound = async () => new Response('missing', { status: 404 })

  it('checks unpublished slugs through a valid binding', async () => {
    const render = catalogRenderer(
      { D1_RUNTIME_ENV: 'production', DB: binding('p') },
      notFound,
      observe
    )
    await render(new Request('https://best.serp.co/products/gone.example/'))
    expect(epoch.isUnpublishedListingSlug).toHaveBeenCalledWith(
      expect.objectContaining({ client: { database: 'p', session: null }, slug: 'gone.example' })
    )
  })

  // #382: the render of a miss reads at its epoch's bookmark; every other render, without one.
  it('renders a miss inside its catalog read, and a bypassed request outside any', async () => {
    const seen: unknown[] = []
    const render = catalogRenderer(
      { D1_RUNTIME_ENV: 'production', DB: binding('p') },
      async () => {
        await Promise.resolve()
        seen.push(currentCatalogRead())
        return new Response('page')
      },
      observe
    )
    const page = () => new Request('https://best.serp.co/products/alpha.example/')
    await render(page(), { bookmark: '00000042-b', token: '7.2026-05-16T00:00:00.000Z' })
    await render(page())
    await render(page(), { bookmark: null, token: '8.none' })
    // A token the catalog does not recognize renders as if there were none.
    await render(page(), { bookmark: '00000042-b', token: 'not-an-epoch' })
    expect(seen).toEqual([
      {
        bookmark: '00000042-b',
        epoch: { effectiveAt: '2026-05-16T00:00:00.000Z', version: 7 }
      },
      null,
      { bookmark: null, epoch: { effectiveAt: null, version: 8 } },
      null
    ])
    expect(currentCatalogRead()).toBeNull()
  })

  it('keeps concurrent renders’ catalog reads apart', async () => {
    const seen = new Map<string, unknown>()
    const render = catalogRenderer(
      { D1_RUNTIME_ENV: 'production', DB: binding('p') },
      async request => {
        await new Promise(resolve => setTimeout(resolve, request.url.includes('slow') ? 5 : 0))
        seen.set(new URL(request.url).pathname, currentCatalogRead()?.bookmark ?? null)
        return new Response('page')
      },
      observe
    )
    await Promise.all([
      render(new Request('https://best.serp.co/products/slow.example/'), {
        bookmark: 'slow',
        token: '1.none'
      }),
      render(new Request('https://best.serp.co/products/fast.example/'), {
        bookmark: 'fast',
        token: '2.none'
      }),
      render(new Request('https://best.serp.co/account/'))
    ])
    expect(Object.fromEntries(seen)).toEqual({
      '/account/': null,
      '/products/fast.example/': 'fast',
      '/products/slow.example/': 'slow'
    })
  })

  it('leaves the 404 alone without a valid binding', async () => {
    const render = catalogRenderer({ D1_RUNTIME_ENV: 'production' }, notFound, observe)
    expect((await render(new Request('https://best.serp.co/products/gone.example/'))).status).toBe(
      404
    )
    expect(epoch.isUnpublishedListingSlug).not.toHaveBeenCalled()
  })
})
