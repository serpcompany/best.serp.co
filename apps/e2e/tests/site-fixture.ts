/**
 * best.serp.co facts the E2E suite asserts against. These values are intentionally hard-coded
 * (instead of imported from `@serpdirectory/site-config`) so a config or catalog regression
 * fails the suite rather than silently moving the expectation with it.
 */
export const site = {
  categoryCount: 140,
  featuredListingCount: 335,
  listingCount: 3422,
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
  return `/products/${slug}/reviews/`
}

export function categoryPath(slug: string): string {
  return `/products/best/${slug}/`
}

export function absoluteUrl(path: string): string {
  return `${site.publicUrl}${path}`
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
