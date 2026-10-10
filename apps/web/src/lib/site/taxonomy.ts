/**
 * The taxonomy's thresholds (#341, design 2.3 and section 7, question 7): constants, not
 * environment variables, so one build serves every environment. `lib/seo/taxonomy-indexing.ts`
 * applies them, for page metadata and the sitemaps alike.
 */

/** A tag page is indexed (and in `sitemap-tags.xml`) from this many public listings. */
export const TAG_INDEX_MIN_LISTINGS = 10

/** A best page is indexed (and in `sitemap-best.xml`) from this many entries; 1 to 4 are noindex. */
export const BEST_PAGE_INDEX_MIN_ENTRIES = 5

/** The tag index links a tag from this many public listings. */
export const TAG_LINK_MIN_LISTINGS = 3

/**
 * Categories that stay as transitional catch-all hubs (design 1.5): noindex, follow, and left out
 * of `sitemap-categories.xml`, until they retire with a redirect (build step 10).
 */
export const TRANSITIONAL_CATEGORY_SLUGS: ReadonlySet<string> = new Set(['other'])
