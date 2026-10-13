/**
 * The taxonomy's thresholds (#341, design 2.3 and section 7, question 7): constants, not
 * environment variables, so one build serves every environment. `lib/seo/taxonomy-indexing.ts`
 * applies them, for page metadata and the sitemaps alike.
 */

/** A tag page is indexed (and in `sitemap-tags.xml`) from this many public listings. */
export const TAG_INDEX_MIN_LISTINGS = 10

/** A best page is indexed (and in `sitemap-best.xml`) from this many entries; 1 to 4 are noindex. */
export const BEST_PAGE_INDEX_MIN_ENTRIES = 5

/** The tag index and a hub's tag chips link a tag from this many public listings. */
export const TAG_LINK_MIN_LISTINGS = 3

/** A listing page names at most this many best pages under "Featured in" (design 5.3). */
export const FEATURED_IN_MAX_PAGES = 3
