import type { PublishedBestPage } from '@/db/contracts'
import { bestPageEntryCount } from '@/lib/seo/taxonomy-indexing'
import { FEATURED_IN_MAX_PAGES } from '@/lib/site/taxonomy'

/** What a listing's detail says about its place in the taxonomy (#341, #347). */
export interface FeaturedInListing {
  /** Its active best-page pins (`position`) and exclusions (null), by page slug. */
  bestPageMarks?: ReadonlyArray<{ page: string; position: number | null }>
  /** Its primary category: its hub. */
  category: string
  /** All its active categories, the primary first. */
  categories?: readonly string[]
  /** Its active tags, the most central first. */
  tags?: ReadonlyArray<{ slug: string }>
}

/**
 * The best pages that show a listing: its "Featured in" (#341 design 5.3, #347), at most
 * `FEATURED_IN_MAX_PAGES`. They come from the cached best index and the listing's own detail, so
 * they cost no statement. A best page shows the listing when either
 *
 * - it pins the listing within the entries it shows: a pin at position `p` ranks `p`th or
 *   higher, since only pins come before it; or
 * - its rule selects the listing (one of its tags, one of its categories, or a tag within one of
 *   them, design 1.3), it doesn't exclude the listing, and it shows its whole pool.
 *
 * An unpinned listing in a pool larger than the page's list may rank below the cut, which only
 * the page's own entries can tell, so it is not named. Pins come first, by position; then pages
 * on the listing's tags, the most central tag first; then pages on a category alone. Ties keep
 * the best index's order.
 */
export function featuredInBestPages(
  listing: FeaturedInListing,
  bestPages: readonly PublishedBestPage[]
): PublishedBestPage[] {
  const marks = new Map<string, number | null>(
    listing.bestPageMarks?.map(mark => [mark.page, mark.position])
  )
  const tagRank = new Map<string, number>(listing.tags?.map((tag, index) => [tag.slug, index]))
  const categories = new Set(listing.categories?.length ? listing.categories : [listing.category])
  // `group`: 0 a pin (`key` its position), 1 a page on a tag (`key` the tag's centrality), 2 a
  // page on a category alone.
  const featured: Array<{ group: number; key: number; order: number; page: PublishedBestPage }> = []

  for (const [order, page] of bestPages.entries()) {
    const shown = bestPageEntryCount(page)
    const position = marks.get(page.slug)
    if (shown === 0 || position === null) continue
    if (position !== undefined && position <= shown) {
      featured.push({ group: 0, key: position, order, page })
      continue
    }
    const tagIndex = page.tag === null ? undefined : tagRank.get(page.tag)
    const selected =
      (page.tag === null || tagIndex !== undefined) &&
      (page.category === null || categories.has(page.category))
    if (!selected || page.poolSize > page.listSize) continue
    featured.push(
      tagIndex === undefined
        ? { group: 2, key: 0, order, page }
        : { group: 1, key: tagIndex, order, page }
    )
  }

  return featured
    .sort(
      (left, right) => left.group - right.group || left.key - right.key || left.order - right.order
    )
    .slice(0, FEATURED_IN_MAX_PAGES)
    .map(({ page }) => page)
}
