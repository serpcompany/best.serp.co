import 'server-only'

import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { linkedCategories, listedBestPages } from '@/lib/seo/taxonomy-indexing'
import {
  getActiveCategories,
  getBestPages,
  getLatestListings,
  getListingNamePage
} from './repository'

/**
 * Whether the header links the best-page index (#347): only while it lists a best page, the test
 * that also makes `/best/` indexable, so the nav never links an index that shows only its heading.
 * It reads the cached best index (per epoch, shared with the pages that list best pages), so it
 * adds no statement of its own. A failed read hides the link instead of failing the page.
 */
export async function linksBestIndex(): Promise<boolean> {
  try {
    return listedBestPages(await getBestPages()).length > 0
  } catch {
    return false
  }
}

/** How many of the newest listings the 404 page links (#53). */
export const NOT_FOUND_NEWEST_LISTINGS = 12

/**
 * What the 404 page links beyond its fixed links (#53), each from one cached read the site
 * already makes: the shell stats, the best index, the newest listings and the directory's first
 * page.
 */
export interface NotFoundLinkTargets {
  /** The best pages that render (`listedBestPages`); the best index is linked while there is one. */
  bestPages: PublishedBestPage[]
  /** Every category with a public listing, by name, as the categories index lists them. */
  categories: PublishedCategory[]
  /** How many public listings there are: the HTML sitemap's numbered pages, labelled by range. */
  listingTotal: number
  /**
   * The newest listings, in the homepage's "recently added" order (D1 stores no view counts, so
   * newest stands in for most viewed).
   */
  newest: { name: string; slug: string }[]
}

/**
 * The 404 page's targets (#53). The categories and best pages come from the cached shell stats and
 * best index the header reads too, the newest from the publication order's cached head, and the
 * listing total from the directory's first page (the homepage's cached read), which counts the
 * same public listings the HTML sitemap pages. A failed read leaves its links out instead of
 * failing the 404.
 */
export async function notFoundLinkTargets(): Promise<NotFoundLinkTargets> {
  const [categories, bestPages, newest, listingTotal] = await Promise.all([
    getActiveCategories().catch(() => []),
    getBestPages().catch(() => []),
    getLatestListings(NOT_FOUND_NEWEST_LISTINGS).catch(() => []),
    getListingNamePage({ page: 1 })
      .then(page => page.total)
      .catch(() => 0)
  ])
  return {
    bestPages: listedBestPages(bestPages),
    categories: linkedCategories(categories),
    listingTotal,
    newest: newest.map(({ name, slug }) => ({ name, slug }))
  }
}
