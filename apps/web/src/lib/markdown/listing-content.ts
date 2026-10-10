import type { Root, RootContent } from 'hast'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * A listing body's Markdown as the HTML syntax tree react-markdown renders (#334). Parsing the
 * Markdown (with GitHub-flavored extensions) was the largest cost the site's own code added to
 * a warm uncached listing render, so the catalog adapter keeps each body's tree in the
 * epoch-keyed data cache (`readContentTree` in `lib/catalog/repository.ts`) and the page renders
 * the cached tree through react-markdown itself (`components/content/markdown-tree.tsx`), with
 * the same components and options, so the markup is the same.
 */
export type ListingContentTree = Root

/**
 * Names the cached trees' shape. Change it whenever the same Markdown would give another tree:
 * a react-markdown, remark-gfm or remark-rehype upgrade that changes their output, a different
 * plugin, or another `stripDuplicateLinksSection`. `listing-content.test.ts` pins the tree of a
 * sample body, so such a change fails there until this is bumped and the pin updated.
 */
export const LISTING_CONTENT_FORMAT = 'gfm-1'

/** A body's trailing "Links" section repeats the resource links the page lists on its own. */
export function stripDuplicateLinksSection(content: string, hasSupplementalLinks: boolean): string {
  if (!hasSupplementalLinks) {
    return content
  }

  return content.replace(/\n## Links[\s\S]*$/i, '').trim()
}

/**
 * The tree react-markdown renders for `content`: its own pipeline (remark-parse, remark-gfm,
 * remark-rehype, then its URL and raw-HTML handling), captured by a rehype plugin. The source
 * positions are dropped; nothing renders them.
 */
export function listingContentTree(content: string, hasSupplementalLinks: boolean): Root {
  let captured: Root | undefined
  Markdown({
    children: stripDuplicateLinksSection(content, hasSupplementalLinks),
    rehypePlugins: [
      () => (tree: Root) => {
        captured = tree
      }
    ],
    remarkPlugins: [remarkGfm]
  })
  if (!captured) throw new Error('react-markdown produced no tree.')
  // react-markdown finishes the captured tree in place (URLs, raw HTML as text) before it returns.
  return withoutPositions(captured)
}

function withoutPositions<T extends Root | RootContent>(node: T): T {
  const { position: _position, ...rest } = node
  if (!('children' in rest)) return rest as T
  const children = (rest.children as RootContent[]).map(child => withoutPositions(child))
  return { ...rest, children } as T
}

/** A data cache value that can be a listing content tree (a hast root). */
export function isListingContentTree(value: unknown): value is ListingContentTree {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Root>
  return candidate.type === 'root' && Array.isArray(candidate.children)
}
