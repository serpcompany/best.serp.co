import React, { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripDuplicateLinksSection } from '../../lib/markdown/listing-content'
import { KITCHEN_SINK_BODY, REVIEW_BODY } from '../../lib/markdown/listing-content-test-support'
import {
  LISTING_MARKDOWN_OPTIONS,
  listingContentTree
} from '../../lib/markdown/listing-content-tree'
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
    ...LISTING_MARKDOWN_OPTIONS,
    children: stripDuplicateLinksSection(body, hasLinks),
    components
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

  it('renders bare URLs as text with their escapes resolved, and links as links (#377)', () => {
    const markup = renderToStaticMarkup(cached(KITCHEN_SINK_BODY, false))
    expect(markup).toContain(
      'www.literal.test, https://bare.test/x?y=1, an escaped\n' +
        'https://bare.test/engines/[model]/run?aff=YOUR_CODE and an escaped'
    )
    expect(markup).not.toContain('href="http://www.literal.test')
    expect(markup).not.toContain('href="https://bare.test')
    expect(markup).not.toContain('%5C')
    expect(markup).toContain('href="https://auto.test/path">https://auto.test/path</a>')
    expect(markup).toContain('title="With a title" href="https://studio.test/a">inline</a>')
    expect(markup).toContain('title="Ref title" href="https://ref.test/page">reference</a>')
  })

  it('keeps bare emails as mailto links, outside code and links (#377)', () => {
    const markup = renderToStaticMarkup(cached(KITCHEN_SINK_BODY, false))
    expect(markup).toContain('href="mailto:hello@studio.test">hello@studio.test</a>')
    // An escape in a bare email resolves before it is linked.
    expect(markup).toContain('href="mailto:john_doe@studio.test">john_doe@studio.test</a>')
    expect(markup).toContain('href="https://studio.test/team">team@studio.test</a>')
    expect(markup).toContain('ops@studio.test</code>')
    expect(markup).not.toContain('mailto:team@')
    expect(markup).not.toContain('mailto:ops@')
  })

  it('leaves an email in a bare URL, or in a rejected address, as text (#377)', () => {
    for (const url of [
      'https://api.example.test/verify?email=foo@bar.test',
      'https://user:pass@host.example.test/',
      'www.example.test/contact?to=sales@example.test',
      'https://api.example.test/v1/users/john.doe@example.test',
      'path/john.doe@example.test'
    ]) {
      const markup = renderToStaticMarkup(cached(`See ${url} for details.`, false))
      expect(markup).toContain(`See ${url} for details.`)
      expect(markup).not.toContain('<a ')
    }
    const markup = renderToStaticMarkup(
      cached('Write to hello@example.test, or see https://example.test/ sales@example.test.', false)
    )
    expect(markup).toContain('href="mailto:hello@example.test">hello@example.test</a>')
    expect(markup).toContain('href="mailto:sales@example.test">sales@example.test</a>')
  })

  it('links no email that starts inside a word or has a letter outside ASCII (#383)', () => {
    for (const text of [
      // Not the word's tail (`user@…`) after `-`, `+` or `.`.
      'naïve-user@example.test',
      'naïve+user@example.test',
      'café.user@example.test',
      // Not `ſ` (U+017F) or the Kelvin sign (U+212A) as an ASCII letter.
      'ſupport@example.test',
      '\u212Aelvin@example.test',
      // Upper- and mixed-case URL prefixes are still bare URLs.
      'HTTPS://api.example.test/verify?email=foo@bar.test',
      'WWW.example.test/contact?to=sales@example.test',
      'HtTp://example.test/?to=sales@example.test'
    ]) {
      const markup = renderToStaticMarkup(cached(`See ${text} for details.`, false))
      expect(markup).toContain(`See ${text} for details.`)
      expect(markup).not.toContain('<a ')
    }
    const markup = renderToStaticMarkup(
      cached('Write to first.last+tag@example.test or (ops-team@example.test).', false)
    )
    expect(markup).toContain('href="mailto:first.last+tag@example.test">first.last+tag@')
    expect(markup).toContain('href="mailto:ops-team@example.test">ops-team@example.test</a>)')
  })

  it('scans a long bare URL once, so hostile runs stay fast (#379 review)', () => {
    // Each run, 20 KB without whitespace, is followed by 200 emails. Checking the text before
    // each email for a URL took about 19 s on this body; one forward scan takes milliseconds.
    const emails = Array.from({ length: 200 }, (_, index) => `u${index}@example.test`).join(' ')
    const body = `${'www.'.repeat(5000)} ${emails}\n\n${'http://'.repeat(3000)}?to=sales@example.test ${emails}`
    const markup = renderToStaticMarkup(cached(body, false))
    expect(markup).toContain(`>${'www.'.repeat(5000)} <a `)
    expect(markup).toContain(`>${'http://'.repeat(3000)}?to=sales@example.test <a `)
    expect(markup.match(/href="mailto:u\d+@example\.test">u\d+@example\.test<\/a>/gu)).toHaveLength(
      400
    )
    expect(markup).not.toContain('mailto:sales@')
    const started = performance.now()
    listingContentTree(body, false)
    // Generous for a slow runner: about 10 ms on Node 24 on an Apple silicon Mac.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('renders everything else as remark-gfm does (#377)', () => {
    const withoutBareUrls = KITCHEN_SINK_BODY.replace(/^<https:\/\/auto\.test.*\n.*\n/mu, '')
    expect(withoutBareUrls).not.toMatch(/bare\.test|john/u)
    expect(renderToStaticMarkup(direct(withoutBareUrls, false))).toBe(
      renderToStaticMarkup(
        ReactMarkdown({ children: withoutBareUrls, components, remarkPlugins: [remarkGfm] })
      )
    )
  })
})
