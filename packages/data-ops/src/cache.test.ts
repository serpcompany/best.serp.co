import { describe, expect, it } from 'vitest'
import { createCacheApiDataCache, noCatalogDataCache } from './cache'

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
    const adapter = createCacheApiDataCache(cache)

    await adapter.put('catalog-published:v2:serp.software:4', { items: [] }, 3600)

    expect(writtenRequest?.url).toBe(
      'https://catalog-data-ops.invalid/catalog-published%3Av2%3Aserp.software%3A4'
    )
    expect(writtenResponse?.headers.get('Cache-Control')).toBe('max-age=3600')
    expect(await writtenResponse?.json()).toEqual({ items: [] })
  })

  it('provides an explicit no-cache rollback adapter', async () => {
    expect(await noCatalogDataCache.get('anything')).toBeNull()
    await expect(noCatalogDataCache.put('anything', {}, 60)).resolves.toBeUndefined()
  })
})
