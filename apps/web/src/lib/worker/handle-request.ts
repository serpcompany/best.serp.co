/**
 * The Worker entry's request pipeline. `apps/web/worker.ts` wires in what only the build
 * produces (the OpenNext handler, the routes manifest, the catalog epoch reader); the order
 * and the environment rules live here so they are type-checked and unit-tested.
 *
 * 1. Canonical host: on a deployed Worker with `CANONICAL_HOST_REDIRECT=on`, a
 *    `*.workers.dev` request without the smoke-test header gets one 308 to that Worker's
 *    canonical host, best.serp.co or staging.best.serp.co (`lib/routing/canonical-host.ts`).
 * 2. Staging's password (#359, `lib/environment/staging-access.ts`): on a Worker that serves as
 *    staging, every request without the password gets a 401, except the smoke-test header,
 *    `/robots.txt` and the billing webhook. A request that passes goes on without its
 *    `Authorization` header. Production and local skip this.
 * 3. Retired URLs without a replacement (`/news`) answer 410 Gone (`lib/routing/retired-paths.ts`).
 * 4. An old root-level listing or category URL, also through a listing slug or category redirect:
 *    one 308 to its current page (`lib/routing/legacy-root.ts`).
 * 5. Trailing slash: one 308 to the canonical page or file URL (`lib/routing/trailing-slash.ts`).
 * 6. Outside public production, `/robots.txt` disallows every crawler; a Worker that serves as
 *    staging also lets its auditor in, with best.serp.co's rules (#359).
 * 7. `/admin` and `/api/admin`: Cloudflare Access (production) and a session cookie, else
 *    503, 403, or 401 (`lib/auth/admin-gate.ts`); pages and handlers then require an admin.
 * 8. The local dev endpoints (`/api/dev/*`, `/api/auth/dev/*`) answer 404 unless the Worker was
 *    reached on a local host (#164). This uses the Worker's own URL: inside OpenNext a client's
 *    `X-Forwarded-Host` becomes `Host`, so a check there alone could be talked past.
 * 9. Everything else is served through the edge HTML cache and OpenNext (`serve`).
 *
 * Every response then carries the configured environment, the Worker version and, outside
 * public production, `X-Robots-Tag: noindex, nofollow` (`lib/environment/site-environment.ts`),
 * which only a staging request that passed the password goes without. These headers are added
 * after the edge cache, from this request alone, so they always describe the Worker, host and
 * client that asked: a stored response never carries them, and one stored for a request that
 * passed the password reaches a smoke-test request with the noindex. The password is checked
 * before the cache, so nothing stored is ever served to a request without it, and a 401 is
 * never stored.
 */
import { adminGate } from '../auth/admin-gate'
import type { AccessEnv, VerifyAccessOptions } from '../auth/cloudflare-access'
import { isLocalRequestHost } from '../environment/local-host'
import {
  isPublicProduction,
  NON_PRODUCTION_ROBOTS_TXT,
  nonProductionRobotsTxt,
  parseSiteEnvironment,
  servesAsStaging,
  stagingRobotsTxt,
  withEnvironmentHeaders
} from '../environment/site-environment'
import { type StagingAccessEnv, stagingAccess } from '../environment/staging-access'
import { type CanonicalHostEnv, canonicalHostRedirect } from '../routing/canonical-host'
import { retiredPathResponse } from '../routing/retired-paths'
import { trailingSlashRedirect } from '../routing/trailing-slash'

export interface WorkerRequestEnv extends CanonicalHostEnv, AccessEnv, StagingAccessEnv {
  CF_VERSION_METADATA?: { id?: string }
}

export interface WorkerRequestPipeline {
  /** Cloudflare Access key resolution for the admin gate (tests pass local keys). */
  access?: VerifyAccessOptions
  /** Patterns of the `next.config.ts` moved-URL redirects (from the routes manifest). */
  configRedirects: readonly RegExp[]
  /** One 308 for an old root-level listing or category URL (`lib/routing/legacy-root.ts`). */
  legacyRoot?: (request: Request) => Promise<Response | null>
  /** Serves a request through the edge HTML cache and OpenNext. */
  serve: (request: Request) => Promise<Response>
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerRequestEnv,
  pipeline: WorkerRequestPipeline
): Promise<Response> {
  const publicProduction = isPublicProduction(env.SITE_ENVIRONMENT, new URL(request.url).host)
  const headers = (response: Response, passedStagingGate = false) =>
    withEnvironmentHeaders(response, {
      environment: parseSiteEnvironment(env.SITE_ENVIRONMENT),
      passedStagingGate,
      publicProduction,
      versionId: env.CF_VERSION_METADATA?.id
    })

  const hostRedirect = canonicalHostRedirect(request, env, pipeline.configRedirects)
  if (hostRedirect) return headers(hostRedirect)
  const access = await stagingAccess(request, env)
  if (access.gate === 'refused') return headers(access.response)
  const admitted = access.gate === 'passed' ? access.request : request
  const robotsTxt = servesAsStaging(env) ? stagingRobotsTxt() : NON_PRODUCTION_ROBOTS_TXT
  const response =
    retiredPathResponse(admitted) ??
    (await pipeline.legacyRoot?.(admitted)) ??
    trailingSlashRedirect(admitted, pipeline.configRedirects) ??
    (publicProduction ? null : nonProductionRobotsTxt(admitted, robotsTxt)) ??
    (await adminGate(admitted, env, pipeline.access)) ??
    devEndpointGate(admitted) ??
    (await pipeline.serve(admitted))
  return headers(response, access.gate === 'passed')
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
