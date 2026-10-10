import {
  SITEMAP_INDEX_PATH,
  site,
  sitemapPaths,
  taxonomyRoutePaths
} from '../apps/web/src/lib/site'

/**
 * Public route shapes of best.serp.co, derived from the checked-in site config the
 * same way `apps/web/src/lib/routing/routes.ts` builds them (trailing slashes included).
 * Scripts use these for publication audit routes and HTTP gates.
 */
function joinRoute(...segments: string[]): string {
  const path = segments
    .map(segment => segment.replace(/^\/+|\/+$/gu, ''))
    .filter(Boolean)
    .join('/')
  return path ? `/${path}/` : '/'
}

export function listingIndexRoute(): string {
  return joinRoute(site.routes.listingBasePath)
}

export function listingRoute(slug: string): string {
  return joinRoute(site.routes.listingBasePath, slug, site.sitemap.listingDetailSuffix ?? '')
}

export function categoryRoute(slug: string): string {
  return joinRoute(site.sitemap.categoryBasePath ?? 'categories', slug)
}

/**
 * The taxonomy's pages (#341, design 2.1), read from the route registry
 * (`apps/web/src/lib/site/site-routes.ts`), which the pages, `getRoute` and the sitemaps read too.
 */
function fillRoute(pattern: string, parameter: string, value: string): string {
  if (!pattern.includes(`[${parameter}]`)) {
    throw new Error(`Route registry pattern ${pattern} has no [${parameter}] segment.`)
  }
  return pattern.replace(`[${parameter}]`, value)
}

/** `/products/tags/`, the tag index. */
export function tagIndexRoute(): string {
  return taxonomyRoutePaths.tagIndex
}

/** `/products/tags/<slug>/`. */
export function tagRoute(slug: string): string {
  return fillRoute(taxonomyRoutePaths.tagPage, 'tag', slug)
}

/** `/best/`, the best-page index. */
export function bestIndexRoute(): string {
  return taxonomyRoutePaths.bestIndex
}

/** `/best/<slug>/`. */
export function bestRoute(slug: string): string {
  return fillRoute(taxonomyRoutePaths.bestPage, 'keyword', slug)
}

/**
 * Sitemap files whose content changes when listings or categories change; the pages sitemap
 * too, since its catalog pages carry the newest listing's lastmod (#218). With `taxonomy`, also
 * the tag and best-page sitemaps, for a publication that changes tags, best pages, or taxonomy
 * redirects (#344). A publication without one records the same routes as before, so every
 * manifest committed before the taxonomy plans exactly as it was reviewed.
 */
export function catalogSitemapRoutes({ taxonomy = false }: { taxonomy?: boolean } = {}): string[] {
  return [
    SITEMAP_INDEX_PATH,
    sitemapPaths.pages,
    sitemapPaths.products,
    sitemapPaths.categories,
    ...(taxonomy ? [sitemapPaths.tags, sitemapPaths.best] : [])
  ]
}
