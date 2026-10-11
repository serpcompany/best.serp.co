import { CodedError } from '@/lib/telemetry/coded-error'
import type { CatalogDataCache } from './contracts'

const CACHE_ORIGIN = 'https://catalog-data-ops.invalid'

export const noCatalogDataCache: CatalogDataCache = {
  async get() {
    return null
  },
  async put() {}
}

/**
 * Every entry is keyed under the environment (`D1_RUNTIME_ENV`): staging and production are
 * custom domains in one zone, whose cache their Workers share, and the same schema and epoch
 * token would otherwise name one entry for both catalogs (#397). Without an environment there
 * is no data cache.
 */
export function createCacheApiDataCache(cache: Cache, environment: string): CatalogDataCache {
  if (!environment) {
    throw new CodedError('d1_runtime_env_invalid', 'The catalog data cache needs an environment.')
  }
  const scope = `${CACHE_ORIGIN}/${encodeURIComponent(environment)}`
  const requestFor = (key: string) => new Request(`${scope}/${encodeURIComponent(key)}`)
  return {
    async get(key) {
      const response = await cache.match(requestFor(key))
      if (!response) return null
      return response.json()
    },
    async put(key, value, ttlSeconds) {
      await cache.put(
        requestFor(key),
        Response.json(value, {
          headers: {
            'Cache-Control': `max-age=${ttlSeconds}`
          }
        })
      )
    }
  }
}
