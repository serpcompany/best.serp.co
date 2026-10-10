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
 * One exception, staging only (#323): on staging's canonical host (`staging.best.serp.co`),
 * robots.txt also lets Ahrefs' Site Audit crawler in, and a request whose `User-Agent` names it
 * gets no environment noindex, so the site can be audited before a release. It stays
 * non-production: every other request there is noindex, and no analytics load.
 *
 * The Worker entry applies the headers and robots.txt (`lib/worker/handle-request.ts`); the
 * root layout gates the analytics (`analyticsForRequest` in `./request-environment.ts`). This module has no
 * Next.js or `server-only` imports so the Worker can run it before OpenNext loads.
 */
import { site } from '../site/site'

export const siteEnvironments = ['local', 'staging', 'production'] as const
export type SiteEnvironment = (typeof siteEnvironments)[number]

/** The production origin (`https://best.serp.co`) and its host. */
export const CANONICAL_ORIGIN = new URL(site.site.publicUrl).origin
export const CANONICAL_HOST = new URL(site.site.publicUrl).host

/** Staging's branded canonical origin (#323) and its host. */
export const STAGING_CANONICAL_ORIGIN = 'https://staging.best.serp.co'
export const STAGING_CANONICAL_HOST = new URL(STAGING_CANONICAL_ORIGIN).host

/**
 * Each deployed environment's canonical origin: the one host it is served on, which its
 * `*.workers.dev` host redirects to (`lib/routing/canonical-host.ts`).
 */
export const CANONICAL_ORIGINS: Readonly<Record<Exclude<SiteEnvironment, 'local'>, string>> = {
  production: CANONICAL_ORIGIN,
  staging: STAGING_CANONICAL_ORIGIN
}

/**
 * Exempts a request from a deployed Worker's canonical-host redirect so CI can test the
 * deployment through its `*.workers.dev` host. It is not a secret: it only reveals the same
 * site on another host, and search engines never send it.
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

/** The one crawler staging's canonical host admits: Ahrefs' Site Audit (#323). */
export const STAGING_AUDIT_CRAWLER = 'AhrefsSiteAudit'
/** robots.txt on staging's canonical host: Ahrefs' Site Audit may crawl, nobody else. */
export const STAGING_CANONICAL_ROBOTS_TXT = `User-agent: ${STAGING_AUDIT_CRAWLER}\nAllow: /\n\n${NON_PRODUCTION_ROBOTS_TXT}`

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

/**
 * True only for the staging Worker answering on its canonical host (`staging.best.serp.co`);
 * its `*.workers.dev` host, and every other Worker, is not.
 */
export function isStagingCanonical(environment: unknown, host: string | null | undefined): boolean {
  return (
    parseSiteEnvironment(environment) === 'staging' &&
    host?.toLowerCase() === STAGING_CANONICAL_HOST
  )
}

/**
 * True for a request to staging's canonical host from Ahrefs' Site Audit: its `User-Agent`
 * names `AhrefsSiteAudit` (in any case). Decided per request from the request alone, never
 * stored: the edge cache keys on neither the `User-Agent` nor this answer.
 */
export function isStagingAuditRequest(environment: unknown, request: Request): boolean {
  return (
    isStagingCanonical(environment, new URL(request.url).host) &&
    (request.headers.get('user-agent') ?? '')
      .toLowerCase()
      .includes(STAGING_AUDIT_CRAWLER.toLowerCase())
  )
}

/** True when an `X-Robots-Tag` value already keeps the response out of the index. */
function blocksIndexing(value: string | null): boolean {
  return value !== null && /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/iu.test(value)
}

/**
 * Outside public production, every `robots.txt` request is answered with a disallow-all file
 * instead of the production one (which lists the sitemap index). Staging's canonical host
 * passes `STAGING_CANONICAL_ROBOTS_TXT`, which also lets Ahrefs' Site Audit in.
 */
export function nonProductionRobotsTxt(
  request: Request,
  body: string = NON_PRODUCTION_ROBOTS_TXT
): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  if (new URL(request.url).pathname !== '/robots.txt') return null
  return new Response(request.method === 'HEAD' ? null : body, {
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
 * admin preview's, is kept). A staging audit request (`isStagingAuditRequest`) gets no
 * environment noindex either, so it sees the headers best.serp.co would send; a page's own
 * noindex still stays.
 */
export function withEnvironmentHeaders(
  response: Response,
  options: {
    environment: SiteEnvironment | null
    publicProduction: boolean
    stagingAudit?: boolean
    versionId?: string
  }
): Response {
  if (response.status < 200) return response
  const headers = new Headers(response.headers)
  headers.set(SITE_ENVIRONMENT_HEADER, options.environment ?? 'unset')
  if (options.versionId) headers.set(WORKER_VERSION_HEADER, options.versionId)
  if (
    !options.publicProduction &&
    !options.stagingAudit &&
    !blocksIndexing(headers.get('x-robots-tag'))
  )
    headers.set('x-robots-tag', NON_PRODUCTION_X_ROBOTS_TAG)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  })
}
