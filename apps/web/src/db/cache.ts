import type { CatalogDataCache } from './contracts'

const CACHE_ORIGIN = 'https://catalog-data-ops.invalid'

export const noCatalogDataCache: CatalogDataCache = {
  async get() {
    return null
  },
  async put() {}
}

export function createCacheApiDataCache(cache: Cache): CatalogDataCache {
  return {
    async get(key) {
      const response = await cache.match(new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`))
      if (!response) return null
      return response.json()
    },
    async put(key, value, ttlSeconds) {
      await cache.put(
        new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`),
        Response.json(value, {
          headers: {
            'Cache-Control': `max-age=${ttlSeconds}`
          }
        })
      )
    }
  }
}
