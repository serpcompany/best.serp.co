/**
 * The route registry (#167; serp web-stack/nextjs-on-workers.md, Rendering and requests): every
 * public page of best.serp.co, once, with whether search engines may index it and which child
 * sitemap lists it. The sitemaps, robots.txt, the footer, and the pages' robots metadata all
 * read it, and `packages/web-core/src/site-routes.test.tsx` holds them to it, so they cannot
 * disagree.
 *
 * Paths are canonical: a trailing slash, and `[param]` for a segment D1 fills in.
 */

/** The child sitemaps, each served at the root (serp websites/features/xml-sitemaps.md). */
export const sitemapGroups = ['pages', 'products', 'categories'] as const
export type SitemapGroup = (typeof sitemapGroups)[number]

/** Where each child sitemap is served; `/sitemap-index.xml` lists exactly these. */
export const sitemapPaths: Record<SitemapGroup, string> = {
  categories: '/sitemap-categories.xml',
  pages: '/sitemap-pages.xml',
  products: '/sitemap-products.xml'
}

export const SITEMAP_INDEX_PATH = '/sitemap-index.xml'

export type SiteRoute = {
  /** The canonical path. */
  path: string
  /** Rendered `index`; false renders `noindex, follow`. */
  indexable: boolean
  /** The child sitemap that lists it, or null. Only an indexable, self-canonical route has one. */
  sitemapGroup: SitemapGroup | null
  /**
   * The route's canonical URL when it renders another route's content. It stays indexable (the
   * canonical consolidates it) and is listed in no sitemap.
   */
  canonicalPath?: string
  /** robots.txt disallows it (and everything under it). Such a route is never indexable. */
  disallow?: true
}

export const siteRoutes = [
  { indexable: true, path: '/', sitemapGroup: 'pages' },
  { indexable: true, path: '/about/', sitemapGroup: 'pages' },
  { indexable: true, path: '/brands/', sitemapGroup: 'pages' },
  { indexable: true, path: '/contact/', sitemapGroup: 'pages' },
  { indexable: true, path: '/legal/', sitemapGroup: 'pages' },
  { indexable: false, path: '/legal/affiliate-disclosure/', sitemapGroup: null },
  { indexable: false, path: '/legal/cookies/', sitemapGroup: null },
  { indexable: false, path: '/legal/dmca/', sitemapGroup: null },
  { indexable: false, path: '/legal/privacy-policy/', sitemapGroup: null },
  { indexable: false, path: '/legal/terms-conditions/', sitemapGroup: null },
  { indexable: true, path: '/pricing/', sitemapGroup: 'pages' },
  // The directory's first page is the homepage's content; `/products/?page=N` paginates it.
  { canonicalPath: '/', indexable: true, path: '/products/', sitemapGroup: null },
  { indexable: true, path: '/products/[slug]/', sitemapGroup: 'products' },
  { indexable: true, path: '/products/categories/', sitemapGroup: 'pages' },
  { indexable: true, path: '/products/categories/[category]/', sitemapGroup: 'categories' },
  { disallow: true, indexable: false, path: '/search/', sitemapGroup: null },
  { indexable: true, path: '/sponsor/', sitemapGroup: 'pages' },
  { disallow: true, indexable: false, path: '/submit/', sitemapGroup: null }
] as const satisfies readonly SiteRoute[]

export type SiteRoutePath = (typeof siteRoutes)[number]['path']

/** The registered route at `path`; throws for an unregistered one, so a typo fails loudly. */
export function siteRoute(path: SiteRoutePath): SiteRoute {
  const route = siteRoutes.find(entry => entry.path === path)
  if (!route) throw new Error(`No registered route ${path}.`)
  return route
}

/** The static routes a child sitemap lists, in registry order. */
export function sitemapRoutePaths(group: SitemapGroup): string[] {
  return siteRoutes
    .filter(route => route.sitemapGroup === group && !route.path.includes('['))
    .map(route => route.path)
}

/** robots.txt `Disallow` values: each disallowed route without its trailing slash (a prefix). */
export function disallowedPaths(): string[] {
  return siteRoutes
    .filter(route => 'disallow' in route && route.disallow)
    .map(route => route.path.replace(/\/$/u, ''))
}
