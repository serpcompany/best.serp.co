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
 * One exception, staging only (#359; serp `standards/staging-access.md`): staging sits behind a
 * password (`./staging-access.ts`), so a request that passed it gets no environment noindex, and
 * the staging Worker writes its own origin (`https://staging.best.serp.co`) in every absolute
 * URL. Its robots.txt still disallows every crawler but its auditor, Ahrefs' Site Audit, which
 * gets best.serp.co's rules. Requests exempt from the password keep the noindex, and no
 * analytics load anywhere on staging.
 *
 * The Worker entry applies the headers and robots.txt (`lib/worker/handle-request.ts`); the
 * root layout gates the analytics (`analyticsForRequest` in `./request-environment.ts`), and
 * pages read their origin through `./site-origin.ts`. This module has no Next.js or
 * `server-only` imports so the Worker can run it before OpenNext loads.
 */
import { absoluteUrl } from '../seo/canonical-url'
import { site } from '../site/site'
import { crawlRules, SITEMAP_INDEX_PATH } from '../site/site-routes'

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

/** The crawler staging's robots.txt admits: Ahrefs' Site Audit (#323, #359). */
export const STAGING_AUDIT_CRAWLER = 'AhrefsSiteAudit'

/**
 * Staging's robots.txt (#359): every crawler is disallowed, except the auditor, which gets
 * best.serp.co's own rules (`crawlRules`, as production's robots.txt) and staging's sitemap index.
 * It is the same on every host the staging Worker answers, and served without the password.
 */
export function stagingRobotsTxt(): string {
  const { allow, disallow } = crawlRules()
  return [
    NON_PRODUCTION_ROBOTS_TXT.trimEnd(),
    '',
    `User-agent: ${STAGING_AUDIT_CRAWLER}`,
    ...allow.map(path => `Allow: ${path}`),
    ...disallow.map(path => `Disallow: ${path}`),
    '',
    `Sitemap: ${absoluteUrl(STAGING_CANONICAL_ORIGIN, SITEMAP_INDEX_PATH)}`,
    ''
  ].join('\n')
}

/** The Worker vars the environment decisions read (`apps/web/wrangler.jsonc`). */
export interface SiteEnvironmentEnv {
  D1_RUNTIME_ENV?: string
  /**
   * `on` makes a local Worker serve as staging (#359): the e2e suite's staging-access Worker
   * (`apps/web/e2e/staging-access-fixture.ts`). Ignored unless the Worker is local.
   */
  LOCAL_STAGING_ACCESS?: string
  SITE_ENVIRONMENT?: string
}

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
 * True for a Worker that serves as staging (#359): the staging Worker (`SITE_ENVIRONMENT`
 * exactly `staging`), on any host, or a local Worker started with `LOCAL_STAGING_ACCESS=on`
 * (`SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` both `local`), which the e2e suite runs. Such a Worker
 * asks for staging's password (`./staging-access.ts`), writes staging's origin in its URLs
 * (`siteOriginFor`), and serves `stagingRobotsTxt`. Production, local, and a missing or
 * misspelled environment never do.
 */
export function servesAsStaging(env: SiteEnvironmentEnv | null | undefined): boolean {
  const environment = parseSiteEnvironment(env?.SITE_ENVIRONMENT)
  if (environment === 'staging') return true
  return (
    environment === 'local' && env?.D1_RUNTIME_ENV === 'local' && env?.LOCAL_STAGING_ACCESS === 'on'
  )
}

/**
 * The origin a Worker writes in every absolute URL it publishes (canonical tags, `og:url`,
 * JSON-LD, sitemaps, the feed, robots.txt's `Sitemap:` line): staging's own,
 * `https://staging.best.serp.co`, on a Worker that serves as staging (#359), and
 * `https://best.serp.co` everywhere else (production, local, a missing or misspelled var). It
 * comes from the Worker's vars, never from the request's `Host`, so a cached page is the same
 * on both sides of staging's password.
 */
export function siteOriginFor(env: SiteEnvironmentEnv | null | undefined): string {
  return servesAsStaging(env) ? STAGING_CANONICAL_ORIGIN : CANONICAL_ORIGIN
}

/** True when an `X-Robots-Tag` value already keeps the response out of the index. */
function blocksIndexing(value: string | null): boolean {
  return value !== null && /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/iu.test(value)
}

/**
 * Outside public production, every `robots.txt` request is answered with a disallow-all file
 * instead of the production one (which lists the sitemap index). A Worker that serves as staging
 * passes `stagingRobotsTxt()`, which also lets its auditor in.
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
 * admin preview's, is kept). A staging request that passed the password check
 * (`passedStagingGate`, `./staging-access.ts`) gets no environment noindex either, so it sees the
 * headers best.serp.co would send; a page's own noindex still stays.
 */
export function withEnvironmentHeaders(
  response: Response,
  options: {
    environment: SiteEnvironment | null
    passedStagingGate?: boolean
    publicProduction: boolean
    versionId?: string
  }
): Response {
  if (response.status < 200) return response
  const headers = new Headers(response.headers)
  headers.set(SITE_ENVIRONMENT_HEADER, options.environment ?? 'unset')
  if (options.versionId) headers.set(WORKER_VERSION_HEADER, options.versionId)
  if (
    !options.publicProduction &&
    !options.passedStagingGate &&
    !blocksIndexing(headers.get('x-robots-tag'))
  )
    headers.set('x-robots-tag', NON_PRODUCTION_X_ROBOTS_TAG)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  })
}
