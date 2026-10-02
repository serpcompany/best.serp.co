/**
 * Trailing-slash redirects, applied by the Worker entry (`apps/web/worker.ts`) to every
 * request before the edge cache and before OpenNext. See docs/ARCHITECTURE.md#url-canonicalization.
 *
 * A page URL without its slash, or a file URL with one, gets one 308 to the canonical form
 * (`@serpdirectory/web-core/canonical-url`); `/api`, `/.well-known`, and `/_next` paths are
 * served as requested. The query string is kept byte for byte, and the `Location` is
 * relative, so the response does not depend on the host or scheme.
 *
 * Moved URLs keep their own redirects in `next.config.ts`. Next.js lets each of those
 * sources match with or without a trailing slash and sends it straight to the final
 * canonical URL, so a request one of them matches is left to OpenNext: redirecting it here
 * first would add a hop (`/products/x/reviews` -> `/products/x/reviews/` -> `/products/x/`).
 *
 * This module has no Next.js imports so it can run before the Next.js server is loaded.
 */
import { canonicalPathname } from '@serpdirectory/web-core/canonical-url'

/**
 * Paths no moved-URL rule may match. Each has many segments and ends in both a page and a
 * file form, so only a pattern that matches (nearly) everything matches them; such a
 * pattern would make the Worker skip every slash redirect.
 */
const SELF_CHECK_PATHS = [
  '/canonical-url-self-check/a/b/c',
  '/canonical-url-self-check/a/b/c/',
  '/canonical-url-self-check/a/b/c.txt/'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function invalidManifest(detail: string): Error {
  return new Error(
    `Invalid .next/routes-manifest.json: ${detail}. The Worker cannot tell which requests ` +
      'next.config.ts redirects, so it refuses to start rather than skip the trailing-slash ' +
      'rule; see apps/web/lib/routing/trailing-slash.ts.'
  )
}

/**
 * The patterns OpenNext tests for the `next.config.ts` redirects, read from Next.js's
 * generated `.next/routes-manifest.json`. OpenNext evaluates each compiled `regex` with
 * `new RegExp(regex)`, so these match exactly the requests it redirects. Rules with
 * `has`/`missing` conditions are excluded: they redirect only some requests, and those
 * requests are still answered, one hop later.
 *
 * Fails closed: a manifest whose shape is not the expected one (no `redirects` array, a rule
 * without a non-empty string `regex`, a pattern that does not compile or that matches every
 * path) throws instead of producing patterns that would silently turn the rule off.
 */
export function configRedirectPatterns(manifest: unknown): RegExp[] {
  const redirects = isRecord(manifest) ? manifest.redirects : undefined
  if (!Array.isArray(redirects)) throw invalidManifest('`redirects` is not an array')
  const patterns: RegExp[] = []
  redirects.forEach((rule: unknown, index) => {
    if (!isRecord(rule)) throw invalidManifest(`redirects[${index}] is not an object`)
    const conditional =
      (Array.isArray(rule.has) && rule.has.length > 0) ||
      (Array.isArray(rule.missing) && rule.missing.length > 0)
    if (rule.internal === true || conditional) return
    if (typeof rule.regex !== 'string' || rule.regex === '') {
      throw invalidManifest(`redirects[${index}].regex is not a non-empty string`)
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(rule.regex)
    } catch {
      throw invalidManifest(`redirects[${index}].regex does not compile`)
    }
    if (SELF_CHECK_PATHS.some(path => pattern.test(path))) {
      throw invalidManifest(`redirects[${index}].regex matches every path`)
    }
    patterns.push(pattern)
  })
  return patterns
}

/**
 * A 308 to the canonical form of a non-canonical page or file URL, or null when the request
 * is already canonical, exempt, or owned by a `next.config.ts` redirect.
 */
export function trailingSlashRedirect(
  request: Request,
  configRedirects: readonly RegExp[]
): Response | null {
  const url = new URL(request.url)
  const canonical = canonicalPathname(url.pathname)
  if (canonical === url.pathname) return null
  if (configRedirects.some(pattern => pattern.test(url.pathname))) return null
  return new Response(null, {
    headers: { location: `${canonical}${url.search}` },
    status: 308
  })
}
