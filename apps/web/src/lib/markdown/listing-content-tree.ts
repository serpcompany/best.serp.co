import type { Root, RootContent } from 'hast'
import Markdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { stripDuplicateLinksSection } from './listing-content'

/**
 * react-markdown's options for a listing body. Every render of a body takes them from here: the
 * cached tree (`listingContentTree`), the component's direct parse when there is no tree
 * (`components/website/website-content-section.tsx`), and the test that holds the two equal
 * (`components/content/markdown-tree.test.tsx`). A change here changes the trees, so it also
 * needs a new `LISTING_CONTENT_FORMAT`.
 */
export const LISTING_MARKDOWN_OPTIONS: Readonly<Pick<Options, 'rehypePlugins' | 'remarkPlugins'>> =
  { remarkPlugins: [remarkGfm] }

/**
 * The tree react-markdown renders for `content` (#334): its own pipeline with
 * `LISTING_MARKDOWN_OPTIONS` (remark-parse, remark-gfm, remark-rehype, then its URL and raw-HTML
 * handling), captured by a last rehype step. The source positions are dropped; nothing renders
 * them. The catalog adapter imports this module only when the data cache has no tree, so
 * react-markdown and remark-gfm load on listing pages alone (`lib/catalog/repository.ts`).
 */
export function listingContentTree(content: string, hasSupplementalLinks: boolean): Root {
  let captured: Root | undefined
  Markdown({
    ...LISTING_MARKDOWN_OPTIONS,
    children: stripDuplicateLinksSection(content, hasSupplementalLinks),
    rehypePlugins: [
      ...(LISTING_MARKDOWN_OPTIONS.rehypePlugins ?? []),
      () => (tree: Root) => {
        captured = tree
      }
    ]
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
