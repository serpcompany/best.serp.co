import React, { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listingContentTree, stripDuplicateLinksSection } from '../../lib/markdown/listing-content'
import { KITCHEN_SINK_BODY, REVIEW_BODY } from '../../lib/markdown/listing-content-test-support'
import { MarkdownTree } from './markdown-tree'
import { components } from './mdx-components'

/**
 * The element tree a server component renders, as the RSC payload would carry it: element
 * types (components by name), keys and props, children in order. react-markdown's `node` prop
 * (the syntax tree, which the site's components drop) is left out: the cached tree has no
 * source positions.
 */
const siteElements = new Set<unknown>(Object.values(components))

function shape(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(shape)
  if (!isValidElement(node)) return node
  const type = node.type
  const { children, node: _node, ...props } = node.props as Record<string, unknown>
  if (siteElements.has(type)) {
    // One of the site's Markdown elements: a server component, rendered as the server would.
    return { key: node.key, rendered: shape((type as (props: unknown) => ReactNode)(node.props)) }
  }
  return { children: shape(children as ReactNode), key: node.key, props, type }
}

/** What each server component returns, rendered through react-markdown as the page does. */
function direct(body: string, hasLinks: boolean) {
  return ReactMarkdown({
    children: stripDuplicateLinksSection(body, hasLinks),
    components,
    remarkPlugins: [remarkGfm]
  })
}

function cached(body: string, hasLinks: boolean) {
  // The data cache stores JSON, so the page renders a parsed copy.
  const tree = JSON.parse(JSON.stringify(listingContentTree(body, hasLinks)))
  return MarkdownTree({ components, tree })
}

describe('a cached listing content tree (#334)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const [name, body] of [
    ['every Markdown construct', KITCHEN_SINK_BODY],
    ['a catalog-shaped review', REVIEW_BODY],
    ['plain text', 'Just one paragraph.'],
    ['an empty body', '']
  ] as const) {
    for (const hasLinks of [false, true]) {
      it(`renders ${name} as parsing does${hasLinks ? ', with resource links' : ''}`, () => {
        const parsed = direct(body, hasLinks)
        const fromCache = cached(body, hasLinks)
        expect(
          shape(ReactMarkdown(fromCache.props as Parameters<typeof ReactMarkdown>[0]))
        ).toEqual(shape(parsed))
        expect(renderToStaticMarkup(fromCache)).toBe(renderToStaticMarkup(parsed))
      })
    }
  }

  it('keeps the rewrites react-markdown makes: unsafe URLs, raw HTML as text, tagged short links', () => {
    const markup = renderToStaticMarkup(cached(KITCHEN_SINK_BODY, true))
    expect(markup).not.toContain('javascript:')
    expect(markup).toContain('&lt;div class=&quot;raw&quot;&gt;Raw HTML block&lt;/div&gt;')
    expect(markup).toContain('href="https://serp.ly/fixture-studio?via=best.serp.co"')
    expect(markup).toContain('<table class="w-full">')
    expect(markup).toContain('data-footnotes')
    // The trailing "Links" section repeats the resource links, so it is left out with them.
    expect(markup).not.toContain('Repeated in the resource links')
    expect(renderToStaticMarkup(cached(KITCHEN_SINK_BODY, false))).toContain(
      'Repeated in the resource links'
    )
  })
})
