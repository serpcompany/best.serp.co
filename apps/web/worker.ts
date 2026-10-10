/**
 * Worker entry: canonical-host, old root-level URL, and trailing-slash redirects, the
 * environment's crawl policy, then the OpenNext-generated handler behind a catalog-epoch-keyed
 * edge cache. Its cron hosts queued listing media, and locally it serves the media bucket at
 * `/_media` (#95).
 *
 * Admin paths pass the Cloudflare Access and session-cookie gate first
 * (`src/lib/auth/admin-gate.ts`).
 *
 * `scheduled()` serves the Cron Triggers in `wrangler.jsonc` (`triggers.crons`): the hourly draft
 * reminders and expiry (#63), the listing media queue every 15 minutes (#95), and the weekly
 * badge program (#66) with its daily rechecks, in `src/lib/worker/scheduled.ts`.
 *
 * Wrangler's `main` points here (OpenNext "custom worker" pattern). The build output it wires
 * in (`.open-next/worker.js`, `.next/routes-manifest.json`) comes through
 * `worker-build-output.js`, so this file typechecks without a build. It only wires: the
 * pipeline lives in `src/lib/worker/handle-request.ts`, `src/lib/worker/catalog.ts`,
 * `src/lib/routing/`, `src/lib/environment/`, and `src/lib/edge-cache/html-cache.ts`, which are
 * unit-tested, and it keeps no state of its own (#165). See
 * docs/architecture.md#environments-and-hosts, docs/urls.md, and docs/caching.md.
 */
import { withEdgeCache } from './src/lib/edge-cache/html-cache'
import { serveLocalMedia } from './src/lib/media/worker-media'
import { legacyRootRedirect, legacyRootSlugMatcher } from './src/lib/routing/legacy-root'
import { configRedirectPatterns } from './src/lib/routing/trailing-slash'
import {
  catalogEpochReader,
  catalogLegacyRootLookup,
  catalogRenderer
} from './src/lib/worker/catalog'
import { handleWorkerRequest } from './src/lib/worker/handle-request'
import {
  handleScheduled,
  type ScheduledContext,
  type ScheduledEnv,
  type ScheduledEvent
} from './src/lib/worker/scheduled'
// The build output, typed by worker-build-output.d.ts (it exists only after a build).
import openNextWorker, {
  routesManifest,
  type WorkerExecutionContext
} from './worker-build-output.js'

// OpenNext's Durable Object classes, which the Worker must export.
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from './worker-build-output.js'

const EDGE_CACHE_NAME = 'edge-html'
/**
 * next.config.ts redirects, which send moved URLs to their canonical page in one hop, and the
 * root-level paths no route serves: old listing and category URLs (#168). A malformed manifest
 * throws here, at startup, so the deploy and every request fail loudly instead of the
 * trailing-slash rule switching off or old URLs silently answering 404.
 */
const configRedirects = fromRoutesManifest(() => configRedirectPatterns(routesManifest))
const legacyRootSlug = fromRoutesManifest(() =>
  legacyRootSlugMatcher(routesManifest, configRedirects)
)

interface WorkerEnv {
  CANONICAL_HOST_REDIRECT?: string
  CF_ACCESS_AUD?: string
  CF_ACCESS_REQUIRED?: string
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_VERSION_METADATA?: { id?: string }
  D1_RUNTIME_ENV?: string
  DB?: D1Database
  MEDIA?: R2Bucket
  SITE_ENVIRONMENT?: string
}

function fromRoutesManifest<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'routes_manifest_invalid',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    throw error
  }
}

function log(event: object): void {
  console.info(JSON.stringify(event))
}

export default {
  scheduled(
    controller: ScheduledEvent,
    env: WorkerEnv & ScheduledEnv,
    context: ScheduledContext
  ): Promise<void> {
    return handleScheduled(controller, env, context)
  },

  async fetch(
    request: Request,
    env: WorkerEnv,
    context: WorkerExecutionContext
  ): Promise<Response> {
    // Local only: the media bucket has no public host there (src/lib/media/worker-media.ts).
    const localMedia = await serveLocalMedia(request, env)
    if (localMedia) return localMedia
    const render = catalogRenderer(
      env,
      rendered => openNextWorker.fetch(rendered, env, context),
      log
    )
    return handleWorkerRequest(request, env, {
      configRedirects,
      legacyRoot: incoming =>
        legacyRootRedirect(incoming, legacyRootSlug, catalogLegacyRootLookup(env, log)),
      // Redirects and the non-production robots.txt are answered before this, so they are
      // never rendered or stored. A cacheable request reaches OpenNext with allowlisted
      // headers only (`renderRequestFor` in src/lib/edge-cache/html-cache.ts). The crawl
      // policy's X-Robots-Tag is added after this, per request (handle-request.ts), so no
      // stored response carries it or its absence.
      serve: async served => {
        const cache = await caches.open(EDGE_CACHE_NAME)
        return withEdgeCache(
          served,
          context,
          {
            cache,
            deploymentId: env.CF_VERSION_METADATA?.id || 'unversioned',
            epoch: catalogEpochReader(env, cache, log),
            observe: log
          },
          render
        )
      }
    })
  }
}
