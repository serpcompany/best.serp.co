/**
 * The canonical form of every best.serp.co URL, per the SERP URL trailing-slash standard
 * (serpcompany/serp `docs/engineering/standards/url-trailing-slash.md`):
 *
 * - the homepage is written as the bare origin (`https://best.serp.co`);
 * - a page ends with a slash (`/about/`, `/products/autoenhance.ai/`);
 * - a file never does (`/robots.txt`, `/sitemap-pages.xml`);
 * - `/api`, `/api/*`, `/.well-known/*`, and framework paths (`/_next/*`) are served exactly
 *   as requested.
 *
 * The Worker entry redirects non-canonical requests with this module
 * (`apps/web/src/lib/routing/trailing-slash.ts`), and sitemaps, canonical tags, and structured
 * data write URLs with it. It has no framework imports so the Worker can load it before
 * Next.js.
 */

import { FILE_EXTENSIONS, hasFileExtension } from '@serpdirectory/utils/file-extensions'

/**
 * Extensions that make a path a file (`@serpdirectory/utils/file-extensions`). Listing slugs
 * are domain names (`autoenhance.ai`), so a dot alone never makes a file, and slug
 * validation rejects a slug ending in one of these.
 */
export { FILE_EXTENSIONS, hasFileExtension }

/** True when the last path segment ends in a known file extension. */
export function isFilePath(pathname: string): boolean {
  return hasFileExtension(pathname.replace(/\/+$/u, '').split('/').at(-1) ?? '')
}

/**
 * True for paths that are never redirected to add or remove a slash: `/api` and everything
 * under it (callers, webhooks, and OAuth break on a redirect), `/.well-known/*`, and
 * framework-owned segments starting with `_` (`/_next/*`). Only the first segment counts,
 * so `/docs/api/` is still a page; the comparison ignores case, as the standard requires.
 */
export function isExemptPath(pathname: string): boolean {
  const firstSegment = (pathname.split('/')[1] ?? '').toLowerCase()
  return firstSegment === 'api' || firstSegment === '.well-known' || firstSegment.startsWith('_')
}

/**
 * The canonical form of a request path: pages gain a trailing slash and files lose it.
 * Exempt paths, the homepage, and paths with empty segments (which OpenNext normalizes
 * itself) are returned unchanged.
 */
export function canonicalPathname(pathname: string): string {
  if (pathname === '/' || isExemptPath(pathname) || pathname.includes('//')) {
    return pathname
  }
  const unslashed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return isFilePath(unslashed) ? unslashed : `${unslashed}/`
}

/**
 * An absolute URL in canonical form. The homepage is the bare origin (`https://best.serp.co`,
 * never `https://best.serp.co/`); build it with this function rather than `new URL()`,
 * whose `href` always adds the slash. A query or fragment is kept as given.
 */
export function absoluteUrl(origin: string, path = '/'): string {
  const base = origin.replace(/\/+$/u, '')
  const [, rawPathname = '', suffix = ''] = /^([^?#]*)(.*)$/su.exec(path) ?? []
  const pathname = canonicalPathname(rawPathname.startsWith('/') ? rawPathname : `/${rawPathname}`)
  return pathname === '/' && !suffix ? base : `${base}${pathname}${suffix}`
}
