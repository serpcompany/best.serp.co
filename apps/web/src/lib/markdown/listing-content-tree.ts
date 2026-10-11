import type { Root, RootContent } from 'hast'
import type { Root as MarkdownRoot } from 'mdast'
import { findAndReplace, type RegExpMatchObject } from 'mdast-util-find-and-replace'
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote'
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmFootnote } from 'micromark-extension-gfm-footnote'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import Markdown, { type Options } from 'react-markdown'
// Declares the processor data the extensions below are added to, as remark-gfm does.
import type {} from 'remark-parse'
import type { Processor } from 'unified'
import { stripDuplicateLinksSection } from './listing-content'

/**
 * remark-gfm with bare emails as its only autolink literals (#377): its footnotes, strikethrough,
 * tables and task lists, added as remark-gfm adds them, and `linkBareEmails`. A bare URL
 * (`https://…` or `www.…`) in a body stays text. The v1 import's bare URLs are mostly API
 * endpoints and code samples, and an autolink literal kept their Markdown escapes (`YOUR\_CODE`)
 * in its text and href; as text, the escapes resolve. `<https://…>` and `[text](url)` are still
 * links. remark-gfm has no option for this.
 */
function remarkGfmWithoutUrlLiterals(this: Processor) {
  const data = this.data()
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    gfmFootnote(),
    gfmStrikethrough(),
    gfmTable(),
    gfmTaskListItem()
  ]
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown()
  ]
  return linkBareEmails
}

/**
 * Links a bare email in body text to `mailto:`. The email pattern and the label check are
 * remark-gfm's (mdast-util-gfm-autolink-literal's `findEmail`). It runs after parsing, so an
 * escape in the address has resolved (`john\_doe@…` links `mailto:john_doe@…`). An email in code
 * (which has no text nodes) or in a link's text stays as it is.
 *
 * remark-gfm's URL literals took whole URLs first. Here the pattern also matches a bare URL, to
 * the next whitespace, and keeps it as text, so an email inside it stays text with it. A rejected
 * address stays text whole too (`/john.doe@…` does not link `doe@…`). Both are returned as text
 * rather than `false`, which would retry the search one character on, inside them; this way the
 * search never goes back, so a long URL costs its length once (#379).
 *
 * A match after `-`, `+` or `.` started inside a longer word, behind a letter `\w` lacks
 * (`naïve-user@…`), so it is rejected rather than linking the word's tail; one character is
 * checked, without a rescan (#383). The pattern has no `i` flag, which with `u` would let `\w`
 * match `ſ` and the Kelvin sign; the URL prefixes spell both cases instead.
 */
function linkBareEmails(tree: MarkdownRoot) {
  findAndReplace(
    tree,
    [
      /(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ww]{3}\.)\S*|(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu,
      (text: string, _local: unknown, domain: string | undefined, match: RegExpMatchObject) =>
        domain === undefined || // a bare URL
        /[-+./]/u.test(match.input.charAt(match.index - 1)) ||
        /[-\d_]$/u.test(domain)
          ? text
          : {
              children: [{ type: 'text', value: text }],
              title: null,
              type: 'link',
              url: `mailto:${text}`
            }
    ],
    { ignore: ['link', 'linkReference'] }
  )
}

/**
 * react-markdown's options for a listing body. Every render of a body takes them from here: the
 * cached tree (`listingContentTree`), the component's direct parse when there is no tree
 * (`components/website/website-content-section.tsx`), and the test that holds the two equal
 * (`components/content/markdown-tree.test.tsx`). A change here changes the trees, so it also
 * needs a new `LISTING_CONTENT_FORMAT`.
 */
export const LISTING_MARKDOWN_OPTIONS: Readonly<Pick<Options, 'rehypePlugins' | 'remarkPlugins'>> =
  { remarkPlugins: [remarkGfmWithoutUrlLiterals] }

/**
 * The tree react-markdown renders for `content` (#334): its own pipeline with
 * `LISTING_MARKDOWN_OPTIONS` (remark-parse, the GFM extensions above, remark-rehype, then its URL
 * and raw-HTML handling), captured by a last rehype step. The source positions are dropped;
 * nothing renders them. The catalog adapter imports this module only when the data cache has no
 * tree, so react-markdown and the GFM extensions load on listing pages alone
 * (`lib/catalog/repository.ts`).
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
