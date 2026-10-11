import { beforeEach, describe, expect, it, vi } from 'vitest'

const epoch = vi.hoisted(() => ({
  isUnpublishedListingSlug: vi.fn(async () => true),
  readCatalogEpoch: vi.fn(async (options: { client: { database: string } }) => ({
    database: options.client.database
  })),
  shareCatalogEpochToken: vi.fn()
}))

vi.mock('@/db/catalog-epoch', () => ({
  catalogEpochToken: (value: { database: string }) => `epoch-of-${value.database}`,
  isUnpublishedListingSlug: epoch.isUnpublishedListingSlug,
  readCatalogEpoch: epoch.readCatalogEpoch,
  shareCatalogEpochToken: epoch.shareCatalogEpochToken
}))
vi.mock('@/db/client', () => ({
  createDatabase: (database: { name: string }) => ({ database: database.name })
}))

const { catalogEpochReader, catalogRenderer } = await import('./catalog')

function binding(name: string): D1Database {
  return { name } as unknown as D1Database
}

function cache(): Cache {
  return {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined)
  } as unknown as Cache
}

const context = { waitUntil: () => {} }
const observe = () => {}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('catalogEpochReader (#165)', () => {
  it('reads the epoch once per database binding and reuses it across requests', async () => {
    const database = binding('a')
    const first = catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, cache(), observe)
    const second = catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, cache(), observe)
    expect(await first(context)).toBe('epoch-of-a')
    expect(await second(context)).toBe('epoch-of-a')
    expect(epoch.readCatalogEpoch).toHaveBeenCalledTimes(1)
    expect(epoch.shareCatalogEpochToken).toHaveBeenCalledWith('epoch-of-a')
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
    expect(await before(context)).toBe('epoch-of-old')
    expect(await after(context)).toBe('epoch-of-new')
  })

  it("loads through the latest request's cache handle, not the first one's", async () => {
    const database = binding('handoff')
    const first = cache()
    const latest = cache()
    const read = catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, first, observe)
    catalogEpochReader({ D1_RUNTIME_ENV: 'local', DB: database }, latest, observe)
    await read(context)
    expect(latest.match).toHaveBeenCalled()
    expect(first.match).not.toHaveBeenCalled()
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

    expect(await catalogEpochReader(staging, zone, observe)(context)).toBe('epoch-of-staging-db')
    expect(await catalogEpochReader(production, zone, observe)(context)).toBe(
      'epoch-of-production-db'
    )
    expect(Object.fromEntries(entries)).toEqual({
      'https://html-cache.invalid/catalog-epoch/production': 'epoch-of-production-db',
      'https://html-cache.invalid/catalog-epoch/staging': 'epoch-of-staging-db'
    })
  })

  it.each([
    { D1_RUNTIME_ENV: 'local' },
    { D1_RUNTIME_ENV: 'preview', DB: binding('a') },
    { DB: binding('a') }
  ])('stays out of the way without a valid binding: %o', async env => {
    expect(await catalogEpochReader(env, cache(), observe)(context)).toBeNull()
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
      expect.objectContaining({ client: { database: 'p' }, slug: 'gone.example' })
    )
  })

  it('leaves the 404 alone without a valid binding', async () => {
    const render = catalogRenderer({ D1_RUNTIME_ENV: 'production' }, notFound, observe)
    expect((await render(new Request('https://best.serp.co/products/gone.example/'))).status).toBe(
      404
    )
    expect(epoch.isUnpublishedListingSlug).not.toHaveBeenCalled()
  })
})
