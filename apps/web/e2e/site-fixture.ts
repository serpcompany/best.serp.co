/**
 * best.serp.co facts the E2E suite asserts against. These values are intentionally hard-coded
 * (instead of imported from `apps/web/src/lib/site`) so a config regression fails the suite
 * rather than silently moving the expectation with it. Catalog facts are not here: the local
 * suite asserts the fixture seed's (`seed-facts.ts`), and the deployed smoke run reads the live
 * catalog (`catalog-sample.ts`).
 */
export const site = {
  /** `?via=` on every serp.ly link the site renders (#169). */
  dubPartnerId: 'best.serp.co',
  name: 'SERP',
  publicUrl: 'https://best.serp.co',
  title: 'SERP Directory of Products and Resources'
} as const

export const featuredBadgeUrls = {
  dark: `${site.publicUrl}/badge/featured-on-serp.co-dark.svg`,
  light: `${site.publicUrl}/badge/featured-on-serp.co-light.svg`
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
