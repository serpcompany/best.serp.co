/**
 * The Worker entry's request pipeline. `apps/web/worker.ts` wires in what only the build
 * produces (the OpenNext handler, the routes manifest, the catalog epoch reader); the order
 * and the environment rules live here so they are type-checked and unit-tested.
 *
 * 1. Canonical host: on the production Worker with `CANONICAL_HOST_REDIRECT=on`, a
 *    `*.workers.dev` request without the smoke-test header gets one 308 to best.serp.co
 *    (`lib/routing/canonical-host.ts`).
 * 2. Trailing slash: one 308 to the canonical page or file URL (`lib/routing/trailing-slash.ts`).
 * 3. Outside public production, `/robots.txt` disallows every crawler.
 * 4. `/admin` and `/api/admin`: Cloudflare Access (production) and a session cookie, else
 *    503, 403, or 401 (`lib/auth/admin-gate.ts`); pages and handlers then require an admin.
 * 5. The local dev endpoints (`/api/dev/*`, `/api/auth/dev/*`) answer 404 unless the Worker was
 *    reached on a local host (#164). This uses the Worker's own URL: inside OpenNext a client's
 *    `X-Forwarded-Host` becomes `Host`, so a check there alone could be talked past.
 * 6. Everything else is served through the edge HTML cache and OpenNext (`serve`).
 *
 * Every response then carries the configured environment, the Worker version and, outside
 * public production, `X-Robots-Tag: noindex, nofollow` (`lib/environment/site-environment.ts`). These headers are
 * added after the edge cache, so they always describe the Worker and host that answered.
 */
import { adminGate } from '../auth/admin-gate'
import type { AccessEnv, VerifyAccessOptions } from '../auth/cloudflare-access'
import { isLocalRequestHost } from '../environment/local-host'
import {
  isPublicProduction,
  nonProductionRobotsTxt,
  parseSiteEnvironment,
  withEnvironmentHeaders
} from '../environment/site-environment'
import { type CanonicalHostEnv, canonicalHostRedirect } from '../routing/canonical-host'
import { trailingSlashRedirect } from '../routing/trailing-slash'

export interface WorkerRequestEnv extends CanonicalHostEnv, AccessEnv {
  CF_VERSION_METADATA?: { id?: string }
}

export interface WorkerRequestPipeline {
  /** Cloudflare Access key resolution for the admin gate (tests pass local keys). */
  access?: VerifyAccessOptions
  /** Patterns of the `next.config.ts` moved-URL redirects (from the routes manifest). */
  configRedirects: readonly RegExp[]
  /** Serves a request through the edge HTML cache and OpenNext. */
  serve: (request: Request) => Promise<Response>
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerRequestEnv,
  pipeline: WorkerRequestPipeline
): Promise<Response> {
  const publicProduction = isPublicProduction(env.SITE_ENVIRONMENT, new URL(request.url).host)
  const response =
    canonicalHostRedirect(request, env, pipeline.configRedirects) ??
    trailingSlashRedirect(request, pipeline.configRedirects) ??
    (publicProduction ? null : nonProductionRobotsTxt(request)) ??
    (await adminGate(request, env, pipeline.access)) ??
    devEndpointGate(request) ??
    (await pipeline.serve(request))
  return withEnvironmentHeaders(response, {
    environment: parseSiteEnvironment(env.SITE_ENVIRONMENT),
    publicProduction,
    versionId: env.CF_VERSION_METADATA?.id
  })
}

const DEV_ENDPOINT_PREFIXES = ['/api/dev/', '/api/auth/dev/']

/** 404 for a local dev endpoint the Worker was not reached on a local host for (#164). */
function devEndpointGate(request: Request): Response | null {
  const { pathname } = new URL(request.url)
  if (!DEV_ENDPOINT_PREFIXES.some(prefix => pathname.startsWith(prefix))) return null
  if (isLocalRequestHost(request.url)) return null
  return Response.json(
    { error: 'not_found' },
    { headers: { 'Cache-Control': 'private, no-store' }, status: 404 }
  )
}
