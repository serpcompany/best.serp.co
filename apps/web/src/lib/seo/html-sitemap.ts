/**
 * The HTML sitemap's numbered listing pages (#53; serp web-stack/html-sitemap.md): about 200
 * links a page, page 1 at `/sitemap/listings/` and page `n` at `/sitemap/listings/<n>/` from 2.
 * `/sitemap/listings/1/` redirects to page 1 (`redirects.ts`), and a page past the last is a 404.
 */
import { getRoute } from '@/lib/routing/routes'

/** Links on each numbered page. */
export const HTML_SITEMAP_PAGE_SIZE = 200

/** A listing as the numbered pages link it. */
export type HtmlSitemapLink = { name: string; slug: string }

export interface HtmlSitemapPage<T> {
  items: T[]
  page: number
  pageCount: number
  total: number
}

/** How many numbered pages `total` items fill; an empty list still has page 1. */
export function htmlSitemapPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / HTML_SITEMAP_PAGE_SIZE))
}

/**
 * The page a `/sitemap/listings/<n>/` segment names: a whole number from 2, written without
 * leading zeros, else null (a 404). Page 1 is the bare URL, so `1` names no page here.
 */
export function parseHtmlSitemapPageSegment(segment: string): number | null {
  return /^[1-9]\d{0,5}$/u.test(segment) && segment !== '1' ? Number(segment) : null
}

/** The canonical URL path of numbered page `page`. */
export function htmlSitemapListingsPath(page: number): string {
  return page <= 1
    ? getRoute('sitemap.listings')
    : getRoute('sitemap.listingsPage', { page: String(page) })
}

/** Page `page` of `items`, or null when it is not a page (past the last, or not a whole number). */
export function htmlSitemapPage<T>(items: readonly T[], page: number): HtmlSitemapPage<T> | null {
  const pageCount = htmlSitemapPageCount(items.length)
  if (!Number.isInteger(page) || page < 1 || page > pageCount) return null
  const start = (page - 1) * HTML_SITEMAP_PAGE_SIZE
  return {
    items: items.slice(start, start + HTML_SITEMAP_PAGE_SIZE),
    page,
    pageCount,
    total: items.length
  }
}
