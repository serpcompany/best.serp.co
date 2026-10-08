import {
  catalogEpochToken,
  isUnpublishedListingSlug,
  legacyRootTarget,
  readCatalogEpoch,
  shareCatalogEpochToken
} from '@/db/catalog-epoch'
import { createDatabase } from '@/db/client'
import { type EdgeCacheContext, EpochMemo, loadSharedEpoch } from '../edge-cache/html-cache'
import { goneListingRenderer } from '../routing/gone-listing'

/** The Worker vars and binding the catalog needs; the rest of the Worker's env is not read. */
export interface CatalogWorkerEnv {
  D1_RUNTIME_ENV?: string
  DB?: D1Database
}

type Observe = (event: object) => void

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

/** The catalog database, or null when the binding or `D1_RUNTIME_ENV` is missing or invalid. */
function catalogDatabase(env: CatalogWorkerEnv): D1Database | null {
  return env.DB && runtimeEnvironments.has(env.D1_RUNTIME_ENV ?? '') ? env.DB : null
}

interface EpochSource {
  /** The latest request's cache handle and logger, which the next load uses. */
  latest: { cache: Cache; observe: Observe }
  memo: EpochMemo
}

/**
 * One epoch memo per database binding, so every request reads the token through its own
 * binding and never through one an earlier request saw (serp web-stack/nextjs-on-workers.md,
 * "Read bindings inside the request"; #165). The binding object is stable within an isolate, so
 * renders there still share one read of the epoch (#77).
 */
const epochSources = new WeakMap<D1Database, EpochSource>()

/**
 * The catalog epoch for the edge HTML cache's keys, or `null` without a valid binding: the
 * cache then stays out of the way, and the Next.js catalog adapter fails closed exactly as it
 * does without this entry.
 */
export function catalogEpochReader(
  env: CatalogWorkerEnv,
  cache: Cache,
  observe: Observe
): (context: EdgeCacheContext) => Promise<string | null> {
  const database = catalogDatabase(env)
  if (!database) return async () => null
  let source = epochSources.get(database)
  if (!source) {
    const created: EpochSource = {
      latest: { cache, observe },
      memo: new EpochMemo(async () => {
        const { cache: latestCache, observe: latestObserve } = created.latest
        const token = await loadSharedEpoch(latestCache, async () =>
          catalogEpochToken(
            await readCatalogEpoch({
              asOf: new Date().toISOString(),
              client: createDatabase(database),
              observe: latestObserve
            })
          )
        )
        // Renders in this isolate reuse it instead of reading the epoch again (#77).
        shareCatalogEpochToken(token)
        return token
      })
    }
    source = created
    epochSources.set(database, source)
  }
  source.latest = { cache, observe }
  const { memo } = source
  return context => memo.current(context)
}

/**
 * Renders through OpenNext; a listing page's 404 for an unpublished slug becomes the 410 gone
 * page, and no incoming request carries the internal gone-render header
 * (`lib/routing/gone-listing.ts`, #64). Without a valid binding the 404 stands.
 */
export function catalogRenderer(
  env: CatalogWorkerEnv,
  render: (request: Request) => Promise<Response>,
  observe: Observe
): (request: Request) => Promise<Response> {
  const database = catalogDatabase(env)
  if (!database) return goneListingRenderer(render)
  return goneListingRenderer(render, slug =>
    isUnpublishedListingSlug({ client: createDatabase(database), observe, slug })
  )
}

/**
 * Where an old root-level URL moved (`lib/routing/legacy-root.ts`, #168), or undefined without
 * a valid binding, when the catalog pages fail closed too.
 */
export function catalogLegacyRootLookup(
  env: CatalogWorkerEnv,
  observe: Observe
): ((slug: string) => Promise<'category' | 'listing' | null>) | undefined {
  const database = catalogDatabase(env)
  if (!database) return undefined
  return slug =>
    legacyRootTarget({
      asOf: new Date().toISOString(),
      client: createDatabase(database),
      observe,
      slug
    })
}
