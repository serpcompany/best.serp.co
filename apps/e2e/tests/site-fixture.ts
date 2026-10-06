/**
 * best.serp.co facts the E2E suite asserts against. These values are intentionally hard-coded
 * (instead of imported from `@serpdirectory/site-config`) so a config or catalog regression
 * fails the suite rather than silently moving the expectation with it.
 */
export const site = {
  categoryCount: 140,
  /**
   * Live listings in the reviewed import, which the local suite runs against. A deployed
   * environment publishes reviewed manifests and admin decisions on top (#100 unpublished 95
   * hijacked domains), so there the suite reads the live count instead (`liveListingCount`).
   */
  listingCount: 3422,
  /**
   * The fewest live listings a deployed environment may show: the import less #100's 95
   * unpublishes, less headroom for admin unpublishes. A lost catalog still fails.
   */
  minimumDeployedListingCount: 3200,
  name: 'SERP',
  publicUrl: 'https://best.serp.co',
  title: 'SERP Directory of Products and Resources'
} as const

export const featuredBadgeUrls = {
  dark: `${site.publicUrl}/badge/featured-on-serp.co-dark.svg`,
  light: `${site.publicUrl}/badge/featured-on-serp.co-light.svg`
} as const

export const sampleCategory = {
  name: 'Video Downloaders',
  slug: 'video-downloaders'
} as const

export function listingPath(slug: string): string {
  return `/products/${slug}/`
}

export function categoryPath(slug: string): string {
  return `/products/categories/${slug}/`
}

export const categoriesIndexPath = '/products/categories/'

/** The canonical absolute URL: the homepage is the bare origin, never `https://best.serp.co/`. */
export function absoluteUrl(path: string): string {
  return path === '/' ? site.publicUrl : `${site.publicUrl}${path}`
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
