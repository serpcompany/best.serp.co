import {
  catalogEpochToken,
  isUnpublishedListingSlug,
  type LegacyRootTarget,
  legacyRootTarget,
  readCatalogEpoch,
  runWithCatalogRead,
  shareCatalogEpochToken
} from '@/db/catalog-epoch'
import { createDatabase, createSessionDatabase } from '@/db/client'
import {
  type EdgeCacheContext,
  EpochMemo,
  type EpochRead,
  loadSharedEpoch
} from '../edge-cache/html-cache'
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
 * The catalog epoch for the edge HTML cache's keys, with the D1 bookmark it was read at (#382), or
 * `null` without a valid binding: the cache then stays out of the way, and the Next.js catalog
 * adapter fails closed exactly as it does without this entry.
 *
 * The epoch is read through a D1 session that any copy of the database may answer: with read
 * replication on, the nearest replica, so the epoch can trail the primary by that replica's lag,
 * as it already trails a publication by up to the memo's age. The render of a miss then reads at
 * that bookmark or newer (`catalogRenderer`). Without replication the primary answers, as before.
 */
export function catalogEpochReader(
  env: CatalogWorkerEnv,
  cache: Cache,
  observe: Observe
): (context: EdgeCacheContext) => Promise<EpochRead | null> {
  const database = catalogDatabase(env)
  if (!database) return async () => null
  let source = epochSources.get(database)
  if (!source) {
    const created: EpochSource = {
      latest: { cache, observe },
      memo: new EpochMemo(async () => {
        const { cache: latestCache, observe: latestObserve } = created.latest
        const read = await loadSharedEpoch(latestCache, async () => {
          const session = database.withSession('first-unconstrained')
          const epoch = await readCatalogEpoch({
            asOf: new Date().toISOString(),
            client: createSessionDatabase(session),
            observe: latestObserve
          })
          return { bookmark: session.getBookmark(), token: catalogEpochToken(epoch) }
        })
        // Bypassed renders in this isolate reuse it instead of reading the epoch again (#77).
        shareCatalogEpochToken(read.token)
        return read
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
 *
 * The render of an edge cache miss runs with the epoch its key names and that epoch's bookmark
 * (`runWithCatalogRead`, #382): its catalog reads key the data cache on that epoch and read at the
 * bookmark or newer, so a lagging replica never fills that epoch's caches with older rows. A render
 * without an epoch (a signed-in or bypassed request) reads the primary. The unpublished-slug check
 * stays on the primary.
 */
export function catalogRenderer(
  env: CatalogWorkerEnv,
  render: (request: Request) => Promise<Response>,
  observe: Observe
): (request: Request, epoch?: EpochRead) => Promise<Response> {
  const database = catalogDatabase(env)
  const renderPage = database
    ? goneListingRenderer(render, slug =>
        isUnpublishedListingSlug({ client: createDatabase(database), observe, slug })
      )
    : goneListingRenderer(render)
  return (request, epoch) =>
    epoch ? runWithCatalogRead(epoch, () => renderPage(request)) : renderPage(request)
}

/**
 * Where an old root-level URL moved (`lib/routing/legacy-root.ts`, #168, #356), or undefined
 * without a valid binding, when the catalog pages fail closed too.
 */
export function catalogLegacyRootLookup(
  env: CatalogWorkerEnv,
  observe: Observe
): ((slug: string) => Promise<LegacyRootTarget | null>) | undefined {
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
