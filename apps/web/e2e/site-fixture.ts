/**
 * best.serp.co facts the E2E suite asserts against. These values are intentionally hard-coded
 * (instead of imported from `apps/web/src/lib/site`) so a config regression fails the suite
 * rather than silently moving the expectation with it. Catalog facts are not here: the local
 * suite asserts the fixture seed's (`seed-facts.ts`), and the deployed smoke run reads the live
 * catalog (`catalog-sample.ts`).
 */
export const site = {
  /**
   * Each deployed Worker's canonical origin, by the `x-site-environment` it reports: its
   * workers.dev host 308s there without the smoke-test header (#323).
   */
  canonicalOrigins: {
    production: 'https://best.serp.co',
    staging: 'https://staging.best.serp.co'
  },
  /** `?via=` on every serp.ly link the site renders (#169). */
  dubPartnerId: 'best.serp.co',
  name: 'SERP',
  publicUrl: 'https://best.serp.co',
  /** Served instead of redirected on a deployed Worker's workers.dev host; CI sends it there. */
  smokeTestHeader: 'x-best-serp-co-smoke-test',
  /**
   * Staging's HTTP Basic auth (#359): shared by SERP sites and stated in serp's staging-access
   * standard, so not a secret. Only the password is checked; people and Ahrefs use `staging`.
   */
  stagingAccess: { password: 'stagingpassword', username: 'staging' },
  title: 'SERP Directory of Products and Resources'
} as const

/**
 * The origin a Worker writes in its absolute URLs (canonicals, JSON-LD, sitemaps, the feed), by
 * the `x-site-environment` it reports: staging writes its own (#359); production and local write
 * best.serp.co.
 */
export function writtenOrigin(environment: string | undefined): string {
  return environment === 'staging' ? site.canonicalOrigins.staging : site.publicUrl
}

/** A deployed Worker's `*.workers.dev` host, which needs the smoke-test header (#323). */
export function isPlatformOrigin(baseURL: string | undefined): boolean {
  return baseURL !== undefined && new URL(baseURL).hostname.endsWith('.workers.dev')
}

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

/**
 * The canonical absolute URL: the homepage is the bare origin, never `https://best.serp.co/`. On
 * best.serp.co unless another origin is given (`writtenOrigin`).
 */
export function absoluteUrl(path: string, origin: string = site.publicUrl): string {
  return path === '/' ? origin : `${origin}${path}`
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
