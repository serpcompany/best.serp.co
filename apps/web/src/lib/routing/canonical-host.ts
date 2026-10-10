/**
 * Canonical-host redirect for the deployed Workers (serpcompany/best.serp.co#42 decision e,
 * #323; serp `docs/engineering/standards/environment-configuration.md`, "Canonical hosts"),
 * applied by the Worker entry before the trailing-slash rule and the edge cache.
 *
 * When `CANONICAL_HOST_REDIRECT=on`, a request for any `*.workers.dev` host (the workers.dev URL
 * and preview URLs) gets one 308 to the Worker's own canonical origin (`CANONICAL_ORIGINS`):
 * `https://best.serp.co` for production, `https://staging.best.serp.co` for staging. The
 * canonical path and the query string are kept byte for byte:
 * `/about?x=1` -> `https://best.serp.co/about/?x=1`. Requests that carry the smoke-test header
 * are served normally so CI can test the deployment through its platform host.
 *
 * Production's switch was `off` until the cutover, while the workers.dev URL was the production
 * review origin, and is `on` since (docs/PRODUCTION_CUTOVER.md, step 5); staging's is `on` since
 * it got `staging.best.serp.co` (#323). Local never redirects, whatever the switch says. Running
 * before the edge cache means a stored response can never answer the wrong client: the redirect
 * is never stored, and the cache only sees workers.dev requests that carry the smoke header.
 */
import { canonicalPathname } from '@/lib/seo/canonical-url'
import {
  CANONICAL_ORIGINS,
  parseSiteEnvironment,
  SMOKE_TEST_HEADER
} from '../environment/site-environment'

const PLATFORM_HOST_SUFFIX = '.workers.dev'

export interface CanonicalHostEnv {
  CANONICAL_HOST_REDIRECT?: string
  SITE_ENVIRONMENT?: string
}

/**
 * The origin this Worker's platform hosts redirect to: the canonical origin of the production
 * or staging Worker with the switch exactly `on`, else null (local, a missing or misspelled
 * environment, or the switch off).
 */
export function canonicalHostRedirectOrigin(env: CanonicalHostEnv): string | null {
  if (env.CANONICAL_HOST_REDIRECT !== 'on') return null
  const environment = parseSiteEnvironment(env.SITE_ENVIRONMENT)
  return environment === 'production' || environment === 'staging'
    ? CANONICAL_ORIGINS[environment]
    : null
}

/** True only for the production or staging Worker with the switch exactly `on`. */
export function canonicalHostRedirectEnabled(env: CanonicalHostEnv): boolean {
  return canonicalHostRedirectOrigin(env) !== null
}

/** Cloudflare's platform hosts for a Worker: `<worker>.<account>.workers.dev` and previews. */
export function isPlatformHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(PLATFORM_HOST_SUFFIX)
}

/**
 * A 308 to the canonical host, or null when the switch is off, the host is not a platform
 * host, or the request carries the smoke-test header. A path a `next.config.ts` moved-URL rule
 * matches keeps its form, and the canonical host then answers that rule's redirect: moving it
 * here would need the rule's destination, which only OpenNext evaluates.
 */
export function canonicalHostRedirect(
  request: Request,
  env: CanonicalHostEnv,
  configRedirects: readonly RegExp[]
): Response | null {
  const origin = canonicalHostRedirectOrigin(env)
  if (!origin) return null
  const url = new URL(request.url)
  if (!isPlatformHost(url.hostname) || request.headers.has(SMOKE_TEST_HEADER)) return null
  const pathname = configRedirects.some(pattern => pattern.test(url.pathname))
    ? url.pathname
    : canonicalPathname(url.pathname)
  return new Response(null, {
    headers: { location: `${origin}${pathname}${url.search}` },
    status: 308
  })
}
