import ReactMarkdown, { type Components } from 'react-markdown'
import type { ListingContentTree } from '../../lib/markdown/listing-content'

/**
 * Renders a tree from `listingContentTree` (`lib/markdown/listing-content-tree.ts`) through
 * react-markdown, which then treats it exactly as a tree it parsed itself: the same URL and raw
 * HTML handling, and the same elements made with `components` (#334). The empty source parses to
 * nothing; the rehype step hands react-markdown the tree instead.
 */
export function MarkdownTree({
  components,
  tree
}: {
  components: Components
  tree: ListingContentTree
}) {
  return (
    <ReactMarkdown components={components} rehypePlugins={[() => () => tree]}>
      {''}
    </ReactMarkdown>
  )
}
