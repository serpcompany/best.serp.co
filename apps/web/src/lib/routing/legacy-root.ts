/**
 * Old root-level listing and category URLs (`/<slug>`, the static site's scheme) answer one 308
 * from the Worker (#168; serp web-stack/nextjs-on-workers.md, The Worker entry). They used to
 * take two hops: the Worker's trailing-slash 308, then a `permanentRedirect` from an
 * `app/[slug]` page, which is gone. A retired listing slug (#356) or a retired category URL
 * (#341) is followed through its redirect to the current page in the same one hop. A root-level
 * path that moved nowhere answers 404.
 *
 * This module has no Next.js imports so it can run before the Next.js server is loaded.
 */
import type { LegacyRootTarget } from '@/db/catalog-epoch'
import type { TaxonomyTarget } from '@/db/contracts'
import { getRoute } from '@/lib/routing/routes'

/**
 * Where `/<slug>` moved, from D1 (`legacyRootTarget`): a public listing (also through a retired
 * listing slug, #356), an active category, the target of a retired category URL (#341), or
 * nothing.
 */
export type LegacyRootLookup = (slug: string) => Promise<LegacyRootTarget | null>

/** The canonical page of a moved taxonomy URL's target (#341, design 2.2). */
export function taxonomyTargetRoute(target: TaxonomyTarget): string {
  switch (target.kind) {
    case 'category':
      return getRoute('category.page', { category: target.slug })
    case 'tag':
      return getRoute('tag.page', { tag: target.slug })
    case 'best':
      return getRoute('best.page', { keyword: target.slug })
    case 'directory':
      return getRoute('listing.list')
  }
}

/**
 * The `Location` of a root-level URL's 308. A listing or category keeps the query string; a
 * retired category's redirect drops it (#341 design 2.2: its `?page=N` would not match the
 * target's pagination).
 */
export function legacyRootLocation(target: LegacyRootTarget, search: string): string {
  if (target.kind === 'moved') return taxonomyTargetRoute(target.target)
  const page =
    target.kind === 'listing'
      ? getRoute('listing.detail', { slug: target.slug })
      : getRoute('category.page', { category: target.slug })
  return `${page}${search}`
}

const ROOT_SEGMENT = /^\/([^/]+)\/?$/u
/**
 * What a listing or category slug can be (the media keys' `slugPattern` in
 * `apps/web/src/db/media-keys.ts`, at most a domain name's 253 characters). Anything else
 * never reaches D1.
 */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,252}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function invalidManifest(detail: string): Error {
  return new Error(
    `Invalid .next/routes-manifest.json: ${detail}. The Worker cannot tell which root-level ` +
      'paths a route serves, so it refuses to start rather than send old listing URLs to 404; ' +
      'see apps/web/src/lib/routing/legacy-root.ts.'
  )
}

/**
 * The compiled `regex` of each manifest entry. Like OpenNext, it compiles them with
 * `new RegExp(regex)` and no flags: Next.js escapes `-` as `\-`, which the `u` flag rejects.
 */
function manifestPatterns(entries: unknown, label: string): RegExp[] {
  if (!Array.isArray(entries)) throw invalidManifest(`\`${label}\` is not an array`)
  return entries.map((entry: unknown, index) => {
    const regex = isRecord(entry) ? entry.regex : undefined
    if (typeof regex !== 'string' || regex === '') {
      throw invalidManifest(`${label}[${index}].regex is not a non-empty string`)
    }
    try {
      return new RegExp(regex)
    } catch {
      throw invalidManifest(`${label}[${index}].regex does not compile`)
    }
  })
}

/**
 * Rewrite sources that take a path ahead of dynamic routes, from either form of `rewrites`: one
 * list (Next.js runs it as `afterFiles`), or the `beforeFiles` and `afterFiles` phases.
 * `fallback` rewrites ran after the old `[slug]` page, so they never served these paths.
 */
function rewritePatterns(rewrites: unknown): RegExp[] {
  if (rewrites === undefined || Array.isArray(rewrites)) {
    return manifestPatterns(rewrites ?? [], 'rewrites')
  }
  if (!isRecord(rewrites)) throw invalidManifest('`rewrites` is neither an array nor an object')
  return (['beforeFiles', 'afterFiles'] as const).flatMap(phase =>
    manifestPatterns(rewrites[phase] ?? [], `rewrites.${phase}`)
  )
}

/**
 * From Next.js's `.next/routes-manifest.json`: the slug of a root-level path that no page,
 * route handler, rewrite, or `next.config.ts` redirect (`configRedirects`, such as `/privacy`)
 * serves, or null for every other path and for anything that cannot be a slug.
 *
 * Fails closed: a manifest whose route lists are missing or malformed throws, at startup,
 * instead of silently sending every old root-level URL to 404.
 */
export function legacyRootSlugMatcher(
  manifest: unknown,
  configRedirects: readonly RegExp[]
): (pathname: string) => string | null {
  if (!isRecord(manifest)) throw invalidManifest('it is not an object')
  const servedPaths = [
    ...manifestPatterns(manifest.staticRoutes, 'staticRoutes'),
    ...manifestPatterns(manifest.dynamicRoutes, 'dynamicRoutes'),
    ...rewritePatterns(manifest.rewrites),
    ...configRedirects
  ]
  return pathname => {
    const segment = ROOT_SEGMENT.exec(pathname)?.[1]
    if (!segment || !SLUG.test(segment)) return null
    return servedPaths.some(pattern => pattern.test(pathname)) ? null : segment
  }
}

/**
 * The answer when D1 cannot say where a path moved: 503, never stored, so neither the edge
 * cache nor a browser keeps a 404 for a URL that has a page.
 */
function lookupUnavailable(): Response {
  return new Response('Service Unavailable', {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '60'
    },
    status: 503
  })
}

/** One 308 from `/<slug>` (with or without its slash) to its target's canonical page. */
export async function legacyRootRedirect(
  request: Request,
  slugFor: (pathname: string) => string | null,
  lookup: LegacyRootLookup | undefined
): Promise<Response | null> {
  if (!lookup || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  const url = new URL(request.url)
  const slug = slugFor(url.pathname)
  if (!slug) return null
  let target: Awaited<ReturnType<LegacyRootLookup>>
  try {
    target = await lookup(slug)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'legacy_root_lookup_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return lookupUnavailable()
  }
  if (!target) return null
  return new Response(null, {
    headers: { location: legacyRootLocation(target, url.search) },
    status: 308
  })
}
