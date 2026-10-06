import { describe, expect, it } from 'vitest'
import {
  B,
  DIFFERENTIAL_CASES,
  ENCODED_SNIPPET,
  ENCODING_CASES,
  L,
  PAGE
} from './badge-differential.fixture'
import { scanFeaturedBadge, verifyFeaturedBadge } from './badge-verifier'

/**
 * The scanner against Chromium's parser on the PR #84 round-2 differential cases. The scanner
 * may be stricter than Chromium (fail closed) but must never pass a page Chromium fails.
 */
const expected = {
  badgeUrls: [B, 'https://best.serp.co/badge/featured-on-serp.co-dark.svg'],
  listingUrl: L
}

function scan(html: string) {
  return scanFeaturedBadge(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    expected,
    PAGE
  )
}

/**
 * Where the scanner is stricter than Chromium, by design: Chromium 147's relaxed `<select>`
 * content model and `document.write` (scripts never run here), and a `<base>` outside
 * `<head>`, which the scanner does not honor.
 */
const STRICTER_THAN_CHROMIUM = new Set([
  'baseAfterAnchor',
  'baseNoHrefThenHref',
  'baseRelative',
  'docWrite',
  'selectOption',
  'selectWrap'
])

/** The badges the hand-written tokenizer passed and Chromium does not (round-2 finding 1). */
const ROUND_TWO_BYPASSES = [
  'scriptDoubleEscape',
  'scriptDoubleEscapeNoClose',
  'scriptDoubleEscapeUpper',
  'cdataForeignBreakout',
  'cdataForeignImg',
  'svgBase',
  'svgSelfCloseUnquoted',
  'svgEndA'
]

describe('badge scanner against Chromium', () => {
  it('has every case of the differential harness', () => {
    expect(DIFFERENTIAL_CASES).toHaveLength(81)
    for (const name of [...STRICTER_THAN_CHROMIUM, ...ROUND_TWO_BYPASSES]) {
      expect(
        DIFFERENTIAL_CASES.some(item => item.name === name),
        name
      ).toBe(true)
    }
  })

  it.each(DIFFERENTIAL_CASES.map(item => [item.name, item] as const))(
    'never passes what Chromium fails: %s',
    (_name, item) => {
      const verdict = scan(item.html)
      if (item.chromium !== 'ok') expect(verdict).toMatchObject({ ok: false })
    }
  )

  it('fails every round-2 bypass', () => {
    for (const name of ROUND_TWO_BYPASSES) {
      const item = DIFFERENTIAL_CASES.find(entry => entry.name === name)
      expect(item?.chromium, name).not.toBe('ok')
      expect(scan(item?.html ?? ''), name).toMatchObject({ ok: false })
    }
  })

  it('agrees with Chromium on pass or fail everywhere else', () => {
    const disagreements = DIFFERENTIAL_CASES.filter(
      item => scan(item.html).ok !== (item.chromium === 'ok')
    ).map(item => item.name)
    expect(disagreements.sort()).toEqual([...STRICTER_THAN_CHROMIUM].sort())
  })

  it('reports the same reason as Chromium for the robots and rel cases', () => {
    for (const name of ['robotsNone', 'robotsInSvg', 'robotsInTemplate', 'robotsOtherBot']) {
      const item = DIFFERENTIAL_CASES.find(entry => entry.name === name)
      const verdict = scan(item?.html ?? '')
      expect(verdict.ok ? 'ok' : verdict.code, name).toBe(item?.chromium)
    }
  })
})

/**
 * PR #84 review round 3, finding 1: the checker decodes a page as Chromium does, so a page
 * whose ASCII snippet a browser reads as other characters (or downloads) never passes.
 */
describe('badge checker against Chromium on encodings', () => {
  const ascii = (text: string) => [...text].map(char => char.charCodeAt(0))
  const check = (bytes: number[], headers: HeadersInit) =>
    verifyFeaturedBadge(
      'https://example.com/',
      expected,
      async () => new Response(new Uint8Array(bytes), { headers, status: 200 })
    )

  it.each(ENCODING_CASES.map(item => [item.name, item] as const))('%s', async (_name, item) => {
    const verdict = await check(
      [...item.prefix, ...(item.snippet ?? ascii(ENCODED_SNIPPET))],
      item.headers
    )
    expect(verdict.ok).toBe(item.chromium.link)
    if (!item.chromium.link) {
      // Text a browser shows has no badge; a page shown as plain text is not HTML; and a page
      // a browser can't show, downloads, or might read in another encoding is unreadable.
      const shown = ['UTF-16LE', 'UTF-16BE', 'ISO-2022-JP'].includes(item.chromium.characterSet)
      const code = shown
        ? 'badge_missing'
        : item.name === 'htmlThenPlainText'
          ? 'not_html'
          : 'page_unreadable'
      expect(verdict).toEqual({ code, ok: false })
    }
  })

  it('reads honestly encoded badges', async () => {
    const utf16le = [0xff, 0xfe, ...[...ENCODED_SNIPPET].flatMap(char => [char.charCodeAt(0), 0])]
    await expect(check(utf16le, { 'Content-Type': 'text/html' })).resolves.toEqual({ ok: true })
    const utf16be = [...ENCODED_SNIPPET].flatMap(char => [0, char.charCodeAt(0)])
    await expect(
      check(utf16be, { 'Content-Type': 'text/html; charset="UTF-16BE"' })
    ).resolves.toEqual({ ok: true })
    // Shift_JIS text (「バッジ」) around the badge, declared in a <meta>.
    const shiftJis = [
      ...ascii('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'),
      0x81,
      0x75,
      0x83,
      0x6f,
      0x83,
      0x62,
      0x83,
      0x57,
      0x81,
      0x76,
      ...ascii(ENCODED_SNIPPET)
    ]
    await expect(check(shiftJis, { 'Content-Type': 'text/html' })).resolves.toEqual({ ok: true })
    for (const disposition of [
      'inline',
      'inline; filename="badge.html"',
      'inline; filename="badge, light.html"',
      'filename=badge.html'
    ]) {
      await expect(
        check(ascii(ENCODED_SNIPPET), {
          'Content-Disposition': disposition,
          'Content-Type': 'text/html'
        }),
        disposition
      ).resolves.toEqual({ ok: true })
    }
  })

  // PR #84 review round 5: the reviewer's honest pages, which Chromium shows with the badge.
  it('reads honest pages whose declarations disagree only harmlessly', async () => {
    const html = [['Content-Type', 'text/html']] as const
    const pages: Array<[string, number[]]> = [
      // A theme's UTF-8 and a plugin's ISO-8859-1, on a pure-ASCII page.
      [
        'theme and plugin',
        ascii(
          `<meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">${ENCODED_SNIPPET}`
        )
      ],
      // An editor's template string, on a pure-ASCII page.
      [
        'template string',
        ascii(
          `<meta charset="utf-8"><script>var t = '<meta charset="iso-8859-1">'</script>${ENCODED_SNIPPET}`
        )
      ],
      // A tracking pixel in <head> moves the <meta> into <body>; it is still in the first
      // 1024 bytes, which Chromium always reads. The page has Latin-1 text (é).
      [
        'meta after a stray element',
        [
          ...ascii('<head><img src="/pixel.gif"><meta charset="iso-8859-1"><p>Caf'),
          0xe9,
          ...ascii(`</p>${ENCODED_SNIPPET}`)
        ]
      ],
      [
        'utf-8 and us-ascii',
        ascii(`<meta charset="utf-8"><meta charset="us-ascii">${ENCODED_SNIPPET}`)
      ],
      [
        'meta text in xmp',
        ascii(`<meta charset="utf-8"><xmp><meta charset="iso-8859-1"></xmp>${ENCODED_SNIPPET}`)
      ],
      // Chromium doesn't trim http-equiv, so the second <meta> declares nothing, even with é.
      [
        'spaced http-equiv',
        [
          ...ascii(
            '<meta charset="utf-8"><meta http-equiv=" content-type " content="text/html; charset=iso-8859-1">'
          ),
          0xc3,
          0xa9,
          ...ascii(ENCODED_SNIPPET)
        ]
      ]
    ]
    for (const [name, bytes] of pages) {
      await expect(check(bytes, html), name).resolves.toEqual({ ok: true })
    }
    // Two identical Content-Type headers, which safeFetch reads as Fetch does.
    await expect(
      check(ascii(ENCODED_SNIPPET), [
        ['Content-Type', 'text/html'],
        ['Content-Type', 'text/html']
      ])
    ).resolves.toEqual({ ok: true })
  })

  // PR #84 review round 4: honest pages whose declarations agree still pass.
  it('reads honest pages with late, repeated, or agreeing declarations', async () => {
    const links = '<link rel="stylesheet" href="/assets/site.css">'.repeat(24)
    const honest = [
      // A late <meta> in <head>, as Chromium reads it: the page is decoded again with it.
      `${links}<meta charset="windows-1252">`,
      // UTF-8 declared twice, and in a script that writes a page.
      '<meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">',
      `<meta charset="utf-8"><script>w.document.write('<meta charset="utf-8">')</script>`,
      // UTF-8 declared only in <body>: the default anyway.
      `<p>Hi</p><meta charset="utf-8">`
    ]
    for (const page of honest) {
      await expect(
        check(ascii(page + ENCODED_SNIPPET), [['Content-Type', 'text/html']]),
        page
      ).resolves.toEqual({ ok: true })
    }
    // A header charset decides; the page's <meta> doesn't count, as in a browser.
    await expect(
      check(ascii(`<meta charset="iso-2022-kr">${ENCODED_SNIPPET}`), [
        ['Content-Type', 'text/html; charset=utf-8']
      ])
    ).resolves.toEqual({ ok: true })
    // Repeated headers that agree.
    await expect(
      check(ascii(ENCODED_SNIPPET), [
        ['Content-Type', 'text/html; charset=utf-8'],
        ['Content-Type', 'text/html; charset=UTF-8']
      ])
    ).resolves.toEqual({ ok: true })
  })
})
