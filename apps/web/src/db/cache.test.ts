import { describe, expect, it } from 'vitest'
import { createCacheApiDataCache, noCatalogDataCache } from './cache'

/** One zone's Cache API, which every Worker on the zone's custom domains reads and writes. */
class ZoneCache {
  readonly entries = new Map<string, string>()

  async match(request: Request): Promise<Response | undefined> {
    const body = this.entries.get(request.url)
    return body === undefined ? undefined : new Response(body)
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, await response.text())
  }
}

describe('catalog data cache adapters', () => {
  it('uses a bounded Cache API entry without exposing the key as a real origin', async () => {
    let writtenRequest: Request | undefined
    let writtenResponse: Response | undefined
    const cache = {
      async match() {
        return undefined
      },
      async put(request: Request, response: Response) {
        writtenRequest = request
        writtenResponse = response
      }
    } as unknown as Cache
    const adapter = createCacheApiDataCache(cache, 'staging')

    await adapter.put('catalog-published:v2:4', { items: [] }, 3600)

    expect(writtenRequest?.url).toBe(
      'https://catalog-data-ops.invalid/staging/catalog-published%3Av2%3A4'
    )
    expect(writtenResponse?.headers.get('Cache-Control')).toBe('max-age=3600')
    expect(await writtenResponse?.json()).toEqual({ items: [] })
  })

  // #397: staging and production share the serp.co zone's cache.
  it('never shares an entry between environments that write the same key', async () => {
    const zone = new ZoneCache()
    const staging = createCacheApiDataCache(zone as unknown as Cache, 'staging')
    const production = createCacheApiDataCache(zone as unknown as Cache, 'production')
    const key = 'catalog-published:v9:21.2026-10-10T00:00:00.000Z'

    await staging.put(key, { catalog: 'staging' }, 60)
    expect(await production.get(key)).toBeNull()

    await production.put(key, { catalog: 'production' }, 60)
    expect(await staging.get(key)).toEqual({ catalog: 'staging' })
    expect(await production.get(key)).toEqual({ catalog: 'production' })
    expect(zone.entries.size).toBe(2)
  })

  it('has no unscoped fallback without an environment', () => {
    expect(() => createCacheApiDataCache(new ZoneCache() as unknown as Cache, '')).toThrow(
      expect.objectContaining({ code: 'd1_runtime_env_invalid' })
    )
  })

  it('provides an explicit no-cache rollback adapter', async () => {
    expect(await noCatalogDataCache.get('anything')).toBeNull()
    await expect(noCatalogDataCache.put('anything', {}, 60)).resolves.toBeUndefined()
  })
})
