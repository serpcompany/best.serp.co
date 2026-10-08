/**
 * Old root-level listing and category URLs (`/<slug>`, the static site's scheme) answer one 308
 * from the Worker (#168; serp web-stack/nextjs-on-workers.md, The Worker entry). They used to
 * take two hops: the Worker's trailing-slash 308, then a `permanentRedirect` from an
 * `app/[slug]` page, which is gone. A root-level path that moved nowhere answers 404.
 *
 * This module has no Next.js imports so it can run before the Next.js server is loaded.
 */
import { getRoute } from '@serpdirectory/web-core/routes'

/** Where `/<slug>` moved, from D1: a public listing, an active category, or nothing. */
export type LegacyRootLookup = (slug: string) => Promise<'category' | 'listing' | null>

const ROOT_SEGMENT = /^\/([^/]+)\/?$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * From Next.js's `.next/routes-manifest.json`: the slug of a root-level path no route serves,
 * or null for every other path (a static page such as `/about`, a dynamic route, `_next`, or
 * anything deeper). `next.config.ts` redirects (`configRedirects`, such as `/privacy`) keep
 * their paths. A manifest without route lists matches nothing.
 */
export function legacyRootSlugMatcher(
  manifest: unknown,
  configRedirects: readonly RegExp[]
): (pathname: string) => string | null {
  const staticRoutes = isRecord(manifest) ? manifest.staticRoutes : undefined
  const dynamicRoutes = isRecord(manifest) ? manifest.dynamicRoutes : undefined
  if (!Array.isArray(staticRoutes) || !Array.isArray(dynamicRoutes)) return () => null
  const staticPages = new Set(
    staticRoutes.flatMap(route =>
      isRecord(route) && typeof route.page === 'string' ? [route.page] : []
    )
  )
  const otherRoutes = dynamicRoutes.flatMap(route =>
    isRecord(route) && typeof route.regex === 'string' ? [new RegExp(route.regex, 'u')] : []
  )
  return pathname => {
    const segment = ROOT_SEGMENT.exec(pathname)?.[1]
    if (!segment || segment.startsWith('_') || segment.startsWith('.')) return null
    if (staticPages.has(`/${segment}`)) return null
    if (otherRoutes.some(pattern => pattern.test(pathname))) return null
    if (configRedirects.some(pattern => pattern.test(pathname))) return null
    try {
      return decodeURIComponent(segment)
    } catch {
      return null
    }
  }
}

/** One 308 from `/<slug>` (with or without its slash) to the listing or category page. */
export async function legacyRootRedirect(
  request: Request,
  slugFor: (pathname: string) => string | null,
  lookup: LegacyRootLookup | undefined
): Promise<Response | null> {
  if (!lookup || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  const url = new URL(request.url)
  const slug = slugFor(url.pathname)
  if (!slug) return null
  const kind = await lookup(slug)
  if (!kind) return null
  const location =
    kind === 'listing'
      ? getRoute('listing.detail', { slug })
      : getRoute('category.page', { category: slug })
  return new Response(null, { headers: { location: `${location}${url.search}` }, status: 308 })
}
