import { parse, serialize } from 'parse5'
import { beforeAll, describe, expect, it } from 'vitest'
import { B, DIFFERENTIAL_CASES, L } from './badge-differential.fixture'
import { scanFeaturedBadge } from './badge-verifier'
import { HTML_LIMITS, HtmlTooComplexError, parseBoundedHtml } from './bounded-html'

const MB = 1_000_000

function page(body: string): string {
  return `<!doctype html><html><head></head><body>${body}</body></html>`
}

function fill(prefix: string, unit: string, size = MB): string {
  return prefix + unit.repeat(Math.ceil((size - prefix.length) / unit.length))
}

function attributes(count: number, name = 'a'): string {
  return Array.from({ length: count }, (_, index) => `${name}${index}=1`).join(' ')
}

/** 1 MB of typical layout, 30 deep, with text, links, lists, a table and scripts. */
function ordinaryPage(): string {
  const wrapper = '<div class="layout"><section><div class="row"><div class="col">'.repeat(6)
  const article = [
    '<article><h2>Heading</h2><p>Some text with a <a href="/x/">link</a>, <em>emphasis</em>',
    ' and <strong>strong words</strong> in a sentence that runs on for a while.</p>',
    '<ul><li><a href="/a/">One</a></li><li><a href="/b/">Two</a></li></ul>',
    '<table><tr><td>1</td><td>2</td></tr></table>',
    '<img src="/i.png" alt="An image" loading="lazy"><script>var x = "<p>"</script></article>'
  ].join('')
  return page(fill(wrapper, article))
}

/**
 * PR #84 review round 3, finding 2: 12 rounds of 500 nested `<b>`s with 41 attributes each
 * (only the last differs), each round closed again. The Noah's Ark check compares every new
 * `<b>` with the open ones: plain parse5 takes about 0.7 s, inside every other limit.
 */
function noahsArkPage(): string {
  const shared = attributes(40)
  let z = 0
  const round = () =>
    Array.from({ length: 500 }, () => `<b ${shared} z=${z++}>`).join('') + '</b>'.repeat(500)
  return Array.from({ length: 12 }, round).join('')
}

function fastestOfThree(run: () => unknown): number {
  run() // warm up
  let fastest = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now()
    run()
    fastest = Math.min(fastest, performance.now() - started)
  }
  return fastest
}

describe('parseBoundedHtml', () => {
  it('builds the same tree as parse5', () => {
    for (const item of DIFFERENTIAL_CASES) {
      const html = page(item.html)
      expect(serialize(parseBoundedHtml(html).document), item.name).toBe(
        serialize(parse(html, { scriptingEnabled: true }))
      )
    }
  })

  it('meters tokens, open-element depth, attributes and sibling searches', () => {
    // html, head, body, div, div; <head> closes before <body>, so the inner <div> is 4 deep.
    const nested = parseBoundedHtml('<div><div></div></div>')
    expect(nested.maxDepth).toBe(4)
    expect(nested.elements).toBe(5)
    // One more <div> costs its start and end tags (1 + depth each) and opening it (its depth).
    const deeper = parseBoundedHtml('<div><div><div></div></div></div>')
    expect(deeper.work - nested.work).toBe(1 + 4 + (1 + 5) + 5)
    // Each attribute costs one more than the last: 1 + 2 + 3 for the third.
    const bare = parseBoundedHtml('<p></p>').work
    expect(parseBoundedHtml('<p a b c></p>').work - bare).toBe(1 + 2 + 3)
    // Fostering a node out of a table searches the table's siblings, which grow each time.
    expect(parseBoundedHtml(`<table>${'<a></a>'.repeat(1000)}`).work).toBeGreaterThan(
      (1000 * 999) / 2
    )
  })

  it('stops at each limit', () => {
    const tooComplex = (html: string) =>
      expect(() => parseBoundedHtml(html)).toThrow(HtmlTooComplexError)
    // Depth: html and body, then 511 divs fit; one more does not.
    expect(parseBoundedHtml('<div>'.repeat(HTML_LIMITS.depth - 2)).maxDepth).toBe(HTML_LIMITS.depth)
    tooComplex('<div>'.repeat(HTML_LIMITS.depth - 1))
    // Elements: html, head and body, then the rest.
    expect(parseBoundedHtml('<br>'.repeat(HTML_LIMITS.elements - 3)).elements).toBe(
      HTML_LIMITS.elements
    )
    tooComplex('<br>'.repeat(HTML_LIMITS.elements - 2))
    // Work: one tag with 5,000 attributes costs about 12.5 million.
    tooComplex(`<p ${attributes(5000)}>`)
    expect(() => parseBoundedHtml('<p a b c>', { ...HTML_LIMITS, work: 10 })).toThrow(
      HtmlTooComplexError
    )
    // The list of active formatting elements: without its charge, this page fits every limit
    // (at about 9.7 million units of work).
    tooComplex(noahsArkPage())
  })

  it('does not merge repeated <html> and <body> attributes', () => {
    const { document } = parseBoundedHtml('<body a=1><body b=2><html c=3>')
    expect(serialize(document)).toBe('<html><head></head><body a="1"></body></html>')
  })

  /**
   * Real pages, first 1 MB, measured on 2026-10-06: work per byte 0.09 to 1.55 (the most was
   * a 35 KB news index; the WHATWG parsing spec, 788 KB, used 0.93 million of the 10
   * million), at most 13,652 elements, and depth at most 35. Sites: Wikipedia (two
   * articles), GitHub, MDN, BBC News, Hacker News, the WHATWG and W3C specs, WordPress.org,
   * best.serp.co, Product Hunt, Elementor, The Verge, CNN, ThemeForest and Shopify.
   * `ordinaryPage()` stands in for them, denser than any.
   */
  it('parses a dense 1 MB page nested 30 deep inside the limits', () => {
    const used = parseBoundedHtml(ordinaryPage())
    expect(used.maxDepth).toBeLessThan(40)
    expect(used.elements).toBeLessThan(HTML_LIMITS.elements / 2)
    // Every byte here is markup 30 deep, which no measured page came close to: 0.8 of the
    // work budget, against 0.1 for the densest real page above at the same size.
    expect(used.work).toBeLessThan(HTML_LIMITS.work)
  })
})

/**
 * PR #84 review round 2, finding 2: 1 MB (the fetch cap) of crafted HTML stays cheap. Each
 * page either parses or stops at a limit within 200 ms on Node 24 on the Apple silicon Mac the
 * limits were measured on (the slowest, 1 MB of `x x x …`, about 60 ms), where plain parse5
 * reads `ordinaryPage()` in about 40 ms. A slower or busier runner gets the same budget
 * scaled by its own time for that page (a CI runner measured about 3 times slower). Before
 * the limits, plain parse5 took about 4.5 minutes on the nested `<div>`s and seconds on
 * several others, which no scaling hides.
 */
describe('badge scanner on 1 MB of crafted HTML', () => {
  const REFERENCE_MS = 40
  let budgetMs = 200
  beforeAll(() => {
    const html = ordinaryPage()
    const referenceMs = fastestOfThree(() => parse(html, { scriptingEnabled: true }))
    budgetMs = 200 * Math.max(1, referenceMs / REFERENCE_MS)
  })
  const expected = {
    badgeUrls: [B],
    listingUrl: L
  }
  const deep = '<span>'.repeat(500)
  const pages: Array<[string, string]> = [
    ['empty comments', fill('', '<!---->')],
    ['comments', fill('', '<!--x-->')],
    ['bang-closed comments', fill('', '<!--x--!>')],
    ['one unclosed comment', fill('', '<!--')],
    ['script escapes', fill('', '<script><!--<script></script>')],
    ['entities', fill('', '&amp;&#x41;&nbsp;')],
    ['alternating text and spaces', fill('', 'x ')],
    ['text under deep formatting', fill(`<b>${deep}`, 'x ')],
    ['links and badge images', fill('', `<a href="${L}"><img src="${B}">`)],
    ['repeated attributes', fill('', `<p a=1 b="2" c='3' `)],
    ['nested <div>s', fill('', '<div>')],
    ['nested tables', fill('', '<table><tr><td>')],
    ['<div>s fostered out of a table', fill('<table>', '<div>')],
    ['links fostered out of a table', fill('<table>', '<a>x')],
    ['<li> under deep nesting', fill(deep, '<li>')],
    ['</p> under deep nesting', fill(deep, '</p>')],
    ['unknown end tags under deep nesting', fill(deep, '</zz>')],
    ['links under deep nesting', fill(deep, '<a>')],
    [
      'reopened formatting',
      Array.from({ length: MB / 20 }, (_, i) => `<p><b x=${i}></p>`).join('')
    ],
    ['distinct formatting', Array.from({ length: MB / 12 }, (_, i) => `<b x=${i}>`).join('')],
    ['misnested formatting', fill('', '<b><div>x</b>')],
    ['formatting around many children', `<b><div>${'<i></i>'.repeat(MB / 7)}</b>`],
    ['one tag with 125,000 attributes', `<p ${attributes(MB / 8)}>`],
    ['an end tag with 125,000 attributes', `</p ${attributes(MB / 8)}>`],
    ['tags with 256 attributes each', fill('', `<p ${attributes(256)}>`)],
    [
      'repeated <body> attributes',
      Array.from({ length: MB / 12 }, (_, i) => `<body b${i}>`).join('')
    ],
    ["nested formatting that fills Noah's Ark", noahsArkPage()]
  ]

  it.each(pages)('%s', (_label, html) => {
    const scan = () => {
      try {
        return scanFeaturedBadge(html, expected)
      } catch (error) {
        if (error instanceof HtmlTooComplexError) return 'too complex'
        throw error
      }
    }
    expect(html.length).toBeGreaterThan(MB * 0.85)
    expect(fastestOfThree(scan)).toBeLessThan(budgetMs)
  })
})
