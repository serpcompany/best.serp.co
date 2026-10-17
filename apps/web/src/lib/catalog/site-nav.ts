import 'server-only'

import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { linkedCategories, listedBestPages } from '@/lib/seo/taxonomy-indexing'
import { getActiveCategories, getBestPages } from './repository'

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

/**
 * What the 404 page links beyond its fixed links (#53), from one cached read each: the data a
 * later section of the page (best pages by hub, say) builds on without another read.
 */
export interface NotFoundLinkTargets {
  /** The best pages that render (`listedBestPages`); the best index is linked while there is one. */
  bestPages: PublishedBestPage[]
  /** Every category with a public listing, by name, as the categories index lists them. */
  categories: PublishedCategory[]
}

/** The 404 page's targets from the shell stats and the best index a page already read. */
export function notFoundLinkTargetsFrom(
  categories: readonly PublishedCategory[],
  bestPages: readonly PublishedBestPage[]
): NotFoundLinkTargets {
  return { bestPages: listedBestPages(bestPages), categories: linkedCategories(categories) }
}

/**
 * The 404 page's targets (#53), from the cached shell stats and best index the header reads too.
 * A failed read leaves its links out instead of failing the 404.
 */
export async function notFoundLinkTargets(): Promise<NotFoundLinkTargets> {
  const [categories, bestPages] = await Promise.all([
    getActiveCategories().catch(() => []),
    getBestPages().catch(() => [])
  ])
  return notFoundLinkTargetsFrom(categories, bestPages)
}
