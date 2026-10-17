/**
 * Which taxonomy pages search engines may index (#341, design 2.3). One predicate per page kind,
 * read by both the page's metadata and its sitemap, so a page is in a sitemap exactly when it
 * renders `index` (`site-routes.test.tsx` holds them to it). A page that is not indexable still
 * renders, `noindex, follow`, so crawlers follow its links; only an empty one is a 404. A
 * category page that renders is always indexed: the catch-all `other`, the one exception, is
 * retired (#351).
 */
import type { PublishedBestPage, PublishedCategory, PublishedTag } from '@/db/contracts'
import {
  BEST_PAGE_INDEX_MIN_ENTRIES,
  TAG_INDEX_MIN_LISTINGS,
  TAG_LINK_MIN_LISTINGS
} from '@/lib/site/taxonomy'

type BestPageSize = Pick<PublishedBestPage, 'listSize' | 'poolSize'>

/** How many entries a best page shows: its pool, up to its `listSize`. Zero is a 404. */
export function bestPageEntryCount(page: BestPageSize): number {
  return Math.min(page.listSize, page.poolSize)
}

/** A best page renders once it has an entry, and is indexed from `BEST_PAGE_INDEX_MIN_ENTRIES`. */
export function isBestPageIndexable(page: BestPageSize): boolean {
  return bestPageEntryCount(page) >= BEST_PAGE_INDEX_MIN_ENTRIES
}

/**
 * A tag page is indexed from `TAG_INDEX_MIN_LISTINGS` public listings, unless an indexable best
 * page ranks that tag alone: the best page then targets the tag's keyword, and the tag page links
 * to it rather than compete with it. A best page that ranks the tag within one category does not
 * count, and neither does one too small to be indexed itself, so the keyword always keeps a page.
 */
export function isTagIndexable(
  tag: Pick<PublishedTag, 'count' | 'slug'>,
  bestPages: readonly Pick<PublishedBestPage, 'category' | 'listSize' | 'poolSize' | 'tag'>[]
): boolean {
  return (
    tag.count >= TAG_INDEX_MIN_LISTINGS &&
    !bestPages.some(
      page => page.tag === tag.slug && page.category === null && isBestPageIndexable(page)
    )
  )
}

/** The tag index links a tag from `TAG_LINK_MIN_LISTINGS` public listings. */
export function isTagLinked(tag: Pick<PublishedTag, 'count'>): boolean {
  return tag.count >= TAG_LINK_MIN_LISTINGS
}

/**
 * The tags the tag index lists. The index itself is always `noindex, follow` and in no sitemap
 * (#425: no page links it), so this decides only what it shows.
 */
export function linkedTags<T extends Pick<PublishedTag, 'count'>>(tags: readonly T[]): T[] {
  return tags.filter(isTagLinked)
}

/** The best pages the best index lists: those with an entry. Empty, it is noindex. */
export function listedBestPages<T extends Pick<PublishedBestPage, 'listSize' | 'poolSize'>>(
  pages: readonly T[]
): T[] {
  return pages.filter(page => bestPageEntryCount(page) > 0)
}

/**
 * The category at `slug` when its page renders: it is active (in the shell stats) and has a
 * public listing (#341 design 2.2). Without one its URL answers a 308 or a 404, so the hub route
 * renders only what this returns, and the 410 page links a hub only when this returns it (#347).
 */
export function renderingCategory<T extends Pick<PublishedCategory, 'count' | 'slug'>>(
  categories: readonly T[],
  slug: string | null | undefined
): T | null {
  if (!slug) return null
  const category = categories.find(candidate => candidate.slug === slug)
  return category && category.count > 0 ? category : null
}

/**
 * The categories whose pages render, by name: the categories index, the 404 page and the HTML
 * sitemap list these (#53).
 */
export function linkedCategories<T extends Pick<PublishedCategory, 'count' | 'name'>>(
  categories: readonly T[]
): T[] {
  return categories
    .filter(category => category.count > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * A hub's best pages that render, in the best index's order: the hub page's "Best {hub} lists",
 * and the ones the 410 page links beside the listing's category (#53).
 */
export function categoryBestPages<
  T extends Pick<PublishedBestPage, 'hub' | 'listSize' | 'poolSize'>
>(bestPages: readonly T[], category: string): T[] {
  return listedBestPages(bestPages.filter(page => page.hub === category))
}
