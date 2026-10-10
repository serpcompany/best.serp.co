/**
 * Which taxonomy pages search engines may index (#341, design 2.3). One predicate per page kind,
 * read by both the page's metadata and its sitemap, so a page is in a sitemap exactly when it
 * renders `index` (`site-routes.test.tsx` holds them to it). A page that is not indexable still
 * renders, `noindex, follow`, so crawlers follow its links; only an empty one is a 404.
 */
import type { PublishedBestPage, PublishedCategory, PublishedTag } from '@/db/contracts'
import {
  BEST_PAGE_INDEX_MIN_ENTRIES,
  TAG_INDEX_MIN_LISTINGS,
  TAG_LINK_MIN_LISTINGS,
  TRANSITIONAL_CATEGORY_SLUGS
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
 * The tags the tag index lists. While it lists none (before the taxonomy is published) the index
 * renders `noindex, follow` and the pages sitemap leaves it out.
 */
export function linkedTags<T extends Pick<PublishedTag, 'count'>>(tags: readonly T[]): T[] {
  return tags.filter(isTagLinked)
}

/** The best pages the best index lists: those with an entry. Empty, it is noindex like the tags'. */
export function listedBestPages<T extends Pick<PublishedBestPage, 'listSize' | 'poolSize'>>(
  pages: readonly T[]
): T[] {
  return pages.filter(page => bestPageEntryCount(page) > 0)
}

/**
 * A category page with a public listing is indexed, except a transitional catch-all hub
 * (`TRANSITIONAL_CATEGORY_SLUGS`: `other`), which stays crawlable for its links.
 */
export function isCategoryIndexable(category: Pick<PublishedCategory, 'slug'>): boolean {
  return !TRANSITIONAL_CATEGORY_SLUGS.has(category.slug)
}
