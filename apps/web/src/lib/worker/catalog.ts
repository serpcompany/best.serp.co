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
  type EpochLookup,
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

/**
 * One epoch memo per database binding, so every request reads the token through its own
 * binding and never through one an earlier request saw (serp web-stack/nextjs-on-workers.md,
 * "Read bindings inside the request"; #165). The binding object is stable within an isolate, so
 * renders there still share one read of the epoch (#77). The memo holds only settled values: each
 * load runs in the request that needs it, through that request's cache handle and logger (#443).
 */
const epochMemos = new WeakMap<D1Database, EpochMemo>()

function epochMemoFor(database: D1Database): EpochMemo {
  const existing = epochMemos.get(database)
  if (existing) return existing
  const memo = new EpochMemo()
  epochMemos.set(database, memo)
  return memo
}

/**
 * The catalog epoch for the edge HTML cache's keys, with the D1 bookmark it was read at (#382), or
 * none (a null `read`) without a valid binding: the cache then stays out of the way, and the
 * Next.js catalog adapter fails closed exactly as it does without this entry.
 *
 * The epoch is read through a D1 session whose first statement goes to the primary
 * (`first-primary`), so every epoch the edge cache, the data center's share and this isolate's
 * renders key on is the primary's, as before #382: a bypassed render, which reuses it and reads the
 * primary, never keys the data cache on a lagging replica's older epoch (#382 review). The render
 * of a miss then reads at the read's bookmark or newer (`catalogRenderer`): the nearest replica
 * answers, and one still behind that bookmark waits until it has caught up, which only a render in
 * the moments after an epoch read (reused for 30 seconds) can meet. Without replication the
 * primary answers everything, as before.
 */
export function catalogEpochReader(
  env: CatalogWorkerEnv,
  cache: Cache,
  observe: Observe
): (context: EdgeCacheContext) => Promise<EpochLookup> {
  const database = catalogDatabase(env)
  if (!database) return async () => ({ read: null })
  // Validated with the binding, and fixed for the binding's Worker: the data center's share of
  // the epoch is keyed on it, so staging and production never read each other's (#397).
  const environment = env.D1_RUNTIME_ENV ?? ''
  const memo = epochMemoFor(database)
  const readPrimary = async (): Promise<EpochRead> => {
    const session = database.withSession('first-primary')
    const epoch = await readCatalogEpoch({
      asOf: new Date().toISOString(),
      client: createSessionDatabase(session),
      observe
    })
    return { bookmark: session.getBookmark(), token: catalogEpochToken(epoch) }
  }
  return context =>
    memo.current(
      context,
      () => loadSharedEpoch(cache, environment, readPrimary, context),
      // Bypassed renders in this isolate reuse the epoch instead of reading it again (#77): the
      // one the memo stored, never an older one a slower, earlier load returned (#443).
      read => shareCatalogEpochToken(read.token)
    )
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
