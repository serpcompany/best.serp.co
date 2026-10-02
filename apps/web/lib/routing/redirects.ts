/**
 * Permanent redirects for moved public URLs, applied by `next.config.ts` `redirects()`.
 *
 * Next.js matches each source with or without a trailing slash, and every destination is
 * written in canonical form (pages end with a slash), so each moved URL reaches its final
 * page in one hop. The Worker's trailing-slash rule (`./trailing-slash.ts`) leaves requests
 * these sources match to OpenNext for that reason. A source with a path parameter gets a
 * second, parameterless rule because OpenNext cannot fill an empty parameter: `/website`
 * would otherwise redirect to the literal `/products/:path*`.
 */
import { site } from '@serpdirectory/site-config'
import type { Redirect } from 'next/dist/lib/load-custom-routes'

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/^\/+|\/+$/g, '')
}

function publicRoute(basePath: string): string {
  return `/${normalizeBasePath(basePath)}`
}

/** `/<from>` and `/<from>/<anything>` -> the same path below `/<to>/`. */
function aliasRedirects(fromBasePath: string, toBasePath: string): Redirect[] {
  const from = publicRoute(fromBasePath)
  const to = publicRoute(toBasePath)
  if (from === to) return []
  return [
    { source: from, destination: `${to}/`, permanent: true },
    { source: `${from}/:path+`, destination: `${to}/:path+/`, permanent: true }
  ]
}

export function movedUrlRedirects(): Redirect[] {
  const listingBasePath = site.routes.listingBasePath
  return [
    {
      source: '/news',
      destination: '/',
      permanent: false
    },
    // Pre-D1 URL scheme (serpcompany/best.serp.co#34): /products/<slug>/reviews/ and
    // /products/best/<category>/. "featured" is a placement flag, not a public page.
    {
      source: '/products/:slug/reviews',
      destination: '/products/:slug/',
      permanent: true
    },
    ...['/products/best', '/products/best/featured', '/categories', '/categories/featured'].map(
      source => ({ source, destination: '/products/categories/', permanent: true })
    ),
    {
      source: '/products/best/:category',
      destination: '/products/categories/:category/',
      permanent: true
    },
    {
      source: '/categories/:category',
      destination: '/products/categories/:category/',
      permanent: true
    },
    ...aliasRedirects('website', listingBasePath),
    ...aliasRedirects('websites', listingBasePath),
    ...aliasRedirects('docs', site.routes.docsBasePath),
    ...aliasRedirects('projects', site.routes.networkBasePath),
    ...aliasRedirects('brands', site.routes.brandsBasePath),
    ...aliasRedirects('guides', 'posts')
  ]
}
