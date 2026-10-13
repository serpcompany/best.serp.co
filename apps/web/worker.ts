/**
 * Worker entry: the canonical-host redirect, staging's password (#359), old root-level URL and
 * trailing-slash redirects, the environment's crawl policy, then the OpenNext-generated handler
 * behind a catalog-epoch-keyed edge cache. Its cron hosts queued listing media, and locally it
 * serves the media bucket at `/_media` (#95).
 *
 * Admin paths pass the Cloudflare Access and session-cookie gate first
 * (`src/lib/auth/admin-gate.ts`). A request for a signed-in or operational surface starts the
 * Sentry server SDK before it renders; public pages never load it
 * (`src/lib/telemetry/server-errors.ts`, #355). An error that escapes this entry, and a cron
 * job's failure, reach Sentry through `src/lib/telemetry/worker-errors.ts` (#210), which loads
 * its SDK only to report one, and never for a public page.
 *
 * `scheduled()` serves the Cron Triggers in `wrangler.jsonc` (`triggers.crons`): the hourly draft
 * reminders and expiry (#63), the listing media queue every 15 minutes (#95), and the weekly
 * badge program (#66) with its daily rechecks, in `src/lib/worker/scheduled.ts`, which
 * `src/lib/worker/run-scheduled.ts` loads only when a trigger fires, so a new isolate's start-up
 * evaluates just the request path (#424).
 *
 * Wrangler's `main` points here (OpenNext "custom worker" pattern). The build output it wires
 * in (`.open-next/worker.js`, `.next/routes-manifest.json`, `.open-next/worker-sentry.json`)
 * comes through `worker-build-output.js`, so this file typechecks without a build. It only
 * wires: the pipeline lives in `src/lib/worker/handle-request.ts`, `src/lib/worker/catalog.ts`,
 * `src/lib/routing/`, `src/lib/environment/`, and `src/lib/edge-cache/html-cache.ts`, which are
 * unit-tested, and it keeps no state of its own (#165). See
 * docs/architecture.md#environments-and-hosts, docs/urls.md, and docs/caching.md.
 */
import { withEdgeCache } from './src/lib/edge-cache/html-cache'
import { serveLocalMedia } from './src/lib/media/worker-media'
import { legacyRootRedirect, legacyRootSlugMatcher } from './src/lib/routing/legacy-root'
import { configRedirectPatterns } from './src/lib/routing/trailing-slash'
import { startServerSentryFor } from './src/lib/telemetry/server-errors'
import { workerErrors } from './src/lib/telemetry/worker-errors'
import {
  catalogEpochReader,
  catalogLegacyRootLookup,
  catalogRenderer
} from './src/lib/worker/catalog'
import { handleWorkerRequest } from './src/lib/worker/handle-request'
import { runScheduled } from './src/lib/worker/run-scheduled'
import type { ScheduledContext, ScheduledEnv, ScheduledEvent } from './src/lib/worker/scheduled'
// The build output, typed by worker-build-output.d.ts (it exists only after a build).
import openNextWorker, {
  routesManifest,
  type WorkerExecutionContext,
  workerSentryBuild
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
/** Worker-entry and cron errors to Sentry, with the DSN and commit the build recorded (#210). */
const errors = workerErrors({ build: workerSentryBuild })

interface WorkerEnv {
  CANONICAL_HOST_REDIRECT?: string
  CF_ACCESS_AUD?: string
  CF_ACCESS_REQUIRED?: string
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_VERSION_METADATA?: { id?: string }
  D1_RUNTIME_ENV?: string
  DB?: D1Database
  LOCAL_STAGING_ACCESS?: string
  MEDIA?: R2Bucket
  SITE_ENVIRONMENT?: string
  STAGING_BASIC_AUTH_PASSWORD?: string
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
    // Loaded on the first trigger, not at start-up: the jobs' modules (email templates, billing,
    // the badge program, the media queue) were about a third of the JavaScript a new isolate ran at
    // start-up (#424). A failed load is reported like a failed job and rethrown.
    return runScheduled(controller, env, context, {
      load: () => import('./src/lib/worker/scheduled'),
      reportFailures: failures => errors.scheduled(failures, controller.cron, env)
    })
  },

  fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    return errors.fetch(request, env, context, () => handleFetch(request, env, context))
  }
}

/** The Worker's request pipeline (`handleWorkerRequest`), behind the local media route. */
async function handleFetch(
  request: Request,
  env: WorkerEnv,
  context: WorkerExecutionContext
): Promise<Response> {
  // Local only: the media bucket has no public host there (src/lib/media/worker-media.ts).
  const localMedia = await serveLocalMedia(request, env)
  if (localMedia) return localMedia
  const render = catalogRenderer(
    env,
    async rendered => {
      await startServerSentryFor(rendered)
      return openNextWorker.fetch(rendered, env, context)
    },
    log
  )
  return handleWorkerRequest(request, env, {
    configRedirects,
    legacyRoot: incoming =>
      legacyRootRedirect(incoming, legacyRootSlug, catalogLegacyRootLookup(env, log)),
    // Staging's 401, redirects and the non-production robots.txt are answered before this,
    // so they are never rendered or stored, and a request without staging's password never
    // reaches a stored page. A cacheable request reaches OpenNext with allowlisted headers
    // only (`renderRequestFor` in src/lib/edge-cache/html-cache.ts). The crawl policy's
    // X-Robots-Tag is added after this, per request (handle-request.ts), so no stored
    // response carries it or its absence.
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
