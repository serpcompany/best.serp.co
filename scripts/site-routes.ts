import { SITEMAP_INDEX_PATH, site, sitemapPaths } from '@serpdirectory/site-config'

/**
 * Public route shapes of best.serp.co, derived from the checked-in site config the
 * same way `packages/web-core/src/routes.ts` builds them (trailing slashes included).
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
 * Sitemap files whose content changes when listings or categories change; the pages sitemap
 * too, since its catalog pages carry the newest listing's lastmod (#218).
 */
export function catalogSitemapRoutes(): string[] {
  return [SITEMAP_INDEX_PATH, sitemapPaths.pages, sitemapPaths.products, sitemapPaths.categories]
}
