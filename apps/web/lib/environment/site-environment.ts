/**
 * What each environment may do in public, read from explicit Worker vars per request (serp
 * `docs/engineering/standards/environment-configuration.md`): a site is non-production unless
 * it is explicitly marked production.
 *
 * A request is **public production** only when `SITE_ENVIRONMENT` is exactly `production` and
 * the request is for the canonical host (`best.serp.co`). Everything else is non-production:
 * local, staging, the production Worker's `*.workers.dev` host, and a missing or misspelled
 * var. Non-production responses carry `X-Robots-Tag: noindex, nofollow`, robots.txt disallows
 * every crawler, and no analytics load (Google Tag Manager, Cloudflare Web Analytics).
 *
 * The Worker entry applies the headers and robots.txt (`lib/worker/handle-request.ts`); the
 * root layout gates the analytics (`analyticsForRequest` in `./request-environment.ts`). This module has no
 * Next.js or `server-only` imports so the Worker can run it before OpenNext loads.
 */
import { site } from '@serpdirectory/site-config'

export const siteEnvironments = ['local', 'staging', 'production'] as const
export type SiteEnvironment = (typeof siteEnvironments)[number]

/** The production origin (`https://best.serp.co`) and its host. */
export const CANONICAL_ORIGIN = new URL(site.site.publicUrl).origin
export const CANONICAL_HOST = new URL(site.site.publicUrl).host

/**
 * Exempts a request from the production Worker's canonical-host redirect so CI can test the
 * deployment through its `*.workers.dev` host. It is not a secret: it only reveals the same
 * public site on another host, and search engines never send it.
 */
export const SMOKE_TEST_HEADER = 'x-best-serp-co-smoke-test'

/** The Worker version (`CF_VERSION_METADATA.id`) that answered; the HTTP gates wait for it. */
export const WORKER_VERSION_HEADER = 'x-worker-version'

/**
 * The `SITE_ENVIRONMENT` the answering Worker is configured with (`unset` when missing or
 * invalid). The HTTP gates read it through the platform host, where the crawl policy is always
 * non-production, to prove the production Worker would serve best.serp.co as production.
 */
export const SITE_ENVIRONMENT_HEADER = 'x-site-environment'

export const NON_PRODUCTION_X_ROBOTS_TAG = 'noindex, nofollow'
export const NON_PRODUCTION_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'

/** The configured environment, or null when the var is missing or not an exact name. */
export function parseSiteEnvironment(value: unknown): SiteEnvironment | null {
  return siteEnvironments.find(environment => environment === value) ?? null
}

/**
 * True only for the production Worker answering on the canonical host. `host` is a URL host
 * or `Host` header value; any other host, including the production `*.workers.dev` review URL,
 * is non-production.
 */
export function isPublicProduction(environment: unknown, host: string | null | undefined): boolean {
  return (
    parseSiteEnvironment(environment) === 'production' && host?.toLowerCase() === CANONICAL_HOST
  )
}

/** True when an `X-Robots-Tag` value already keeps the response out of the index. */
function blocksIndexing(value: string | null): boolean {
  return value !== null && /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/iu.test(value)
}

/**
 * Outside public production, every `robots.txt` request is answered with a disallow-all file
 * instead of the production one (which lists the sitemap index).
 */
export function nonProductionRobotsTxt(request: Request): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  if (new URL(request.url).pathname !== '/robots.txt') return null
  return new Response(request.method === 'HEAD' ? null : NON_PRODUCTION_ROBOTS_TXT, {
    headers: {
      'cache-control': 'public, max-age=0, must-revalidate',
      'content-type': 'text/plain; charset=utf-8'
    }
  })
}

/**
 * The response with the environment headers every Worker response carries: the configured
 * environment, the Worker version when it is known and, outside public production,
 * `X-Robots-Tag: noindex, nofollow` (an existing value that already says `noindex`, such as the
 * admin preview's, is kept).
 */
export function withEnvironmentHeaders(
  response: Response,
  options: { environment: SiteEnvironment | null; publicProduction: boolean; versionId?: string }
): Response {
  if (response.status < 200) return response
  const headers = new Headers(response.headers)
  headers.set(SITE_ENVIRONMENT_HEADER, options.environment ?? 'unset')
  if (options.versionId) headers.set(WORKER_VERSION_HEADER, options.versionId)
  if (!options.publicProduction && !blocksIndexing(headers.get('x-robots-tag')))
    headers.set('x-robots-tag', NON_PRODUCTION_X_ROBOTS_TAG)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  })
}
