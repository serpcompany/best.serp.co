import type { Root } from 'hast'

/**
 * A listing body's Markdown as the HTML syntax tree react-markdown renders (#334). Parsing the
 * Markdown (with GitHub-flavored extensions) was the largest cost the site's own code added to
 * a warm uncached listing render, so the catalog adapter keeps each body's tree in the
 * epoch-keyed data cache (`readContentTree` in `lib/catalog/repository.ts`) and the page renders
 * the cached tree through react-markdown itself (`components/content/markdown-tree.tsx`), with
 * the same components and options, so the markup is the same.
 *
 * This module imports no Markdown library, so every catalog route can read the cache with it;
 * `./listing-content-tree` builds a tree, and loads react-markdown only where one is needed.
 */
export type ListingContentTree = Root

/**
 * Names the cached trees' shape. Change it whenever the same Markdown would give another tree:
 * a react-markdown, remark-gfm or remark-rehype upgrade that changes their output, other
 * `LISTING_MARKDOWN_OPTIONS`, or another `stripDuplicateLinksSection`. `listing-content.test.ts`
 * pins the tree of a sample body, so such a change fails there until this is bumped and the pin
 * updated.
 */
export const LISTING_CONTENT_FORMAT = 'gfm-1'

/** A body's trailing "Links" section repeats the resource links the page lists on its own. */
export function stripDuplicateLinksSection(content: string, hasSupplementalLinks: boolean): string {
  if (!hasSupplementalLinks) {
    return content
  }

  return content.replace(/\n## Links[\s\S]*$/i, '').trim()
}

/** A data cache value that can be a listing content tree (a hast root). */
export function isListingContentTree(value: unknown): value is ListingContentTree {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Root>
  return candidate.type === 'root' && Array.isArray(candidate.children)
}
