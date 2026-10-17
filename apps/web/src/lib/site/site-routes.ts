/**
 * The route registry (#167; serp web-stack/nextjs-on-workers.md, Rendering and requests): every
 * public page of best.serp.co, once, with whether search engines may index it and which child
 * sitemap lists it. The sitemaps, robots.txt, the footer, and the pages' robots metadata all
 * read it, and `apps/web/src/lib/seo/site-routes.test.tsx` holds them to it, so they cannot
 * disagree.
 *
 * Paths are canonical: a trailing slash, and `[param]` for a segment D1 fills in.
 */

/** The child sitemaps, each served at the root (serp websites/features/xml-sitemaps.md). */
export const sitemapGroups = ['pages', 'products', 'categories', 'tags', 'best'] as const
export type SitemapGroup = (typeof sitemapGroups)[number]

/** Where each child sitemap is served; `/sitemap-index.xml` lists exactly these. */
export const sitemapPaths: Record<SitemapGroup, string> = {
  best: '/sitemap-best.xml',
  categories: '/sitemap-categories.xml',
  pages: '/sitemap-pages.xml',
  products: '/sitemap-products.xml',
  tags: '/sitemap-tags.xml'
}

/**
 * The taxonomy's pages (#341, design 2.1): the tag index and tag pages beside the category pages,
 * and the best-page index and best pages at the root. `routes.ts` (`getRoute`) and
 * `scripts/site-routes.ts` (the publisher's affected routes) build their URLs from these.
 */
export const taxonomyRoutePaths = {
  bestIndex: '/best/',
  bestPage: '/best/[keyword]/',
  tagIndex: '/products/tags/',
  tagPage: '/products/tags/[tag]/'
} as const

export const SITEMAP_INDEX_PATH = '/sitemap-index.xml'

/**
 * The HTML sitemap (#53; serp web-stack/html-sitemap.md): the page for people, and the numbered
 * pages that list every listing. `/sitemap/listings/1/` redirects to the bare listings page
 * (`redirects.ts`), and a page past the last answers 404.
 */
export const htmlSitemapPaths = {
  index: '/sitemap/',
  listings: '/sitemap/listings/',
  listingsPage: '/sitemap/listings/[page]/'
} as const

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
  // The best-page index lists a best page once it has an entry. While it lists none it renders
  // noindex and the pages sitemap leaves it out (`listedBestPages`, `lib/seo/taxonomy-indexing.ts`).
  { indexable: true, path: taxonomyRoutePaths.bestIndex, sitemapGroup: 'pages' },
  // Indexed at `BEST_PAGE_INDEX_MIN_ENTRIES` entries (`isBestPageIndexable`).
  { indexable: true, path: taxonomyRoutePaths.bestPage, sitemapGroup: 'best' },
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
  // No page links the tag index, so it is `noindex, follow` and in no sitemap (#425): crawlers
  // still follow its links to the tag pages, which keep their own rule (`isTagIndexable`).
  { indexable: false, path: taxonomyRoutePaths.tagIndex, sitemapGroup: null },
  // Indexed at `TAG_INDEX_MIN_LISTINGS` listings, unless a best page ranks it (`isTagIndexable`).
  { indexable: true, path: taxonomyRoutePaths.tagPage, sitemapGroup: 'tags' },
  { disallow: true, indexable: false, path: '/search/', sitemapGroup: null },
  // The HTML sitemap (#53): every page of it is indexable and canonical to itself, so crawlers
  // walk all of them. The pages sitemap lists each numbered page (`getPageEntries`).
  { indexable: true, path: htmlSitemapPaths.index, sitemapGroup: 'pages' },
  { indexable: true, path: htmlSitemapPaths.listings, sitemapGroup: 'pages' },
  { indexable: true, path: htmlSitemapPaths.listingsPage, sitemapGroup: 'pages' },
  { disallow: true, indexable: false, path: '/submit/', sitemapGroup: null }
] as const satisfies readonly SiteRoute[]

/** The static routes a child sitemap lists, in registry order. */
export function sitemapRoutePaths(group: SitemapGroup): string[] {
  return siteRoutes
    .filter(route => route.sitemapGroup === group && !route.path.includes('['))
    .map(route => route.path)
}

const LISTING_CHILD_PAGE = /^\/products\/([^/[\]]+)\/$/u

/**
 * Slugs no listing may take (#341, design 2.1): the registry's own pages directly under
 * `/products/` (`categories`, `tags`), which `/products/<slug>/` would otherwise shadow. The
 * publisher's manifest schema, submission intake and the admin panel's approval refuse them.
 */
export const reservedListingSlugs: ReadonlySet<string> = new Set(
  siteRoutes.flatMap(route => LISTING_CHILD_PAGE.exec(route.path)?.[1] ?? [])
)

/** True for a slug `reservedListingSlugs` holds. */
export function isReservedListingSlug(slug: string): boolean {
  return reservedListingSlugs.has(slug)
}

/** robots.txt `Disallow` values: each disallowed route without its trailing slash (a prefix). */
export function disallowedPaths(): string[] {
  return siteRoutes
    .filter(route => 'disallow' in route && route.disallow)
    .map(route => route.path.replace(/\/$/u, ''))
}

/**
 * The robots.txt rules best.serp.co gives every crawler. Staging's robots.txt gives its auditor
 * the same rules (#359), so an audit of staging catches a rule that would block real pages.
 */
export function crawlRules(): { allow: string[]; disallow: string[] } {
  return { allow: ['/'], disallow: disallowedPaths() }
}
