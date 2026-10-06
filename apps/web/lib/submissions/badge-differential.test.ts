import { describe, expect, it } from 'vitest'
import { B, DIFFERENTIAL_CASES, L, PAGE } from './badge-differential.fixture'
import { scanFeaturedBadge } from './badge-verifier'

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
