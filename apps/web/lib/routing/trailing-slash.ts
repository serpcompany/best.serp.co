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

/** The part of Next.js's generated `.next/routes-manifest.json` this module reads. */
export interface RoutesManifestRedirects {
  redirects?: ReadonlyArray<{
    has?: unknown[]
    internal?: boolean
    missing?: unknown[]
    regex: string
  }>
}

/**
 * The patterns OpenNext tests for the `next.config.ts` redirects. OpenNext evaluates each
 * compiled `regex` with `new RegExp(regex)`, so these match exactly the requests it
 * redirects. Rules with `has`/`missing` conditions are excluded: they redirect only some
 * requests, and those requests are still answered, one hop later.
 */
export function configRedirectPatterns(manifest: RoutesManifestRedirects): RegExp[] {
  return (manifest.redirects ?? [])
    .filter(rule => !rule.internal && !rule.has?.length && !rule.missing?.length)
    .map(rule => new RegExp(rule.regex))
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
