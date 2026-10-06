import { describe, expect, it } from 'vitest'
import { scanFeaturedBadge, verifyFeaturedBadge } from './badge-verifier'

const lightBadgeUrl = 'https://best.serp.co/badge/featured-on-serp.co-light.svg'
const listingUrl = 'https://best.serp.co/products/example.com/'
const validBadgeHtml = `<a href="${listingUrl}"><img src="${lightBadgeUrl}"></a>`

const expected = {
  badgeUrls: [lightBadgeUrl, 'https://best.serp.co/badge/featured-on-serp.co-dark.svg'],
  listingUrl
}

describe('badge scanner', () => {
  it('requires the expected image inside a dofollow listing link', () => {
    expect(scanFeaturedBadge(validBadgeHtml, expected)).toEqual({ ok: true })
    expect(
      scanFeaturedBadge(
        `<a href="${listingUrl.replace(/\/$/, '')}"><img src="${lightBadgeUrl}"></a>`,
        expected
      )
    ).toEqual({ ok: true })
    expect(
      scanFeaturedBadge(
        `<a rel="noopener noreferrer" target="_blank" href="${listingUrl}"><img src="${lightBadgeUrl}"></a>`,
        expected
      )
    ).toEqual({ ok: true })
  })

  // Owner decision on #84: the badge must be a plain followed link.
  it('fails a link marked nofollow, sponsored, or ugc, in any case or token order', () => {
    const badge = (rel: string) =>
      scanFeaturedBadge(`<a href="${listingUrl}" ${rel}><img src="${lightBadgeUrl}"></a>`, expected)
    const cases: Array<[string, string[]]> = [
      ['rel="nofollow"', ['nofollow']],
      ['rel="sponsored"', ['sponsored']],
      ['rel="ugc"', ['ugc']],
      ['rel="NoFollow"', ['nofollow']],
      ["rel='UGC noopener'", ['ugc']],
      ['rel=sponsored', ['sponsored']],
      ['rel="noopener\tSponsored\nnoreferrer"', ['sponsored']],
      ['rel="ugc nofollow"', ['nofollow', 'ugc']],
      ['rel="noopener sponsored nofollow ugc"', ['nofollow', 'sponsored', 'ugc']],
      ['rel="&#110;ofollow"', ['nofollow']]
    ]
    for (const [rel, tokens] of cases) {
      expect(badge(rel), rel).toEqual({ code: 'link_not_followed', ok: false, rel: tokens })
    }
    // Tokens only count whole: neither `nofollower` nor a `data-rel` attribute is a rel token.
    for (const rel of ['rel="nofollower ugc-like"', 'data-rel="nofollow"', 'rel=""', '']) {
      expect(badge(rel), rel).toEqual({ ok: true })
    }
    // The first rel attribute wins, as in a browser.
    expect(badge('rel="noopener" rel="nofollow"')).toEqual({ ok: true })
    expect(badge('rel="nofollow" rel="noopener"')).toMatchObject({ code: 'link_not_followed' })
  })

  it('passes when any badge on the page has a followed link to the listing', () => {
    const marked = `<a rel="nofollow" href="${listingUrl}"><img src="${lightBadgeUrl}"></a>`
    expect(scanFeaturedBadge(`${marked}${validBadgeHtml}`, expected)).toEqual({ ok: true })
    // An unfollowed listing link is reported before a badge that links elsewhere.
    const elsewhere = `<a href="https://best.serp.co/"><img src="${lightBadgeUrl}"></a>`
    expect(scanFeaturedBadge(`${elsewhere}${marked}`, expected)).toEqual({
      code: 'link_not_followed',
      ok: false,
      rel: ['nofollow']
    })
  })

  it('rejects the wrong destination and absent badge', () => {
    expect(
      scanFeaturedBadge(
        `<a href="https://best.serp.co/"><img src="${lightBadgeUrl}"></a>`,
        expected
      )
    ).toEqual({ ok: false, code: 'wrong_destination', href: 'https://best.serp.co/' })
    expect(
      scanFeaturedBadge(
        `<a href="https://best.serp.co/products/example.com/reviews/"><img src="${lightBadgeUrl}"></a>`,
        expected
      )
    ).toEqual({
      ok: false,
      code: 'wrong_destination',
      href: 'https://best.serp.co/products/example.com/reviews/'
    })
    expect(scanFeaturedBadge(`<a><img src="${lightBadgeUrl}"></a>`, expected)).toEqual({
      ok: false,
      code: 'wrong_destination'
    })
    expect(scanFeaturedBadge('<p>No badge</p>', expected)).toEqual({
      ok: false,
      code: 'badge_missing'
    })
  })
})

// PR #84 review round 1, finding 1: only what a browser renders, with the real attributes.
describe('badge scanner tokenizer', () => {
  const L = listingUrl
  const B = lightBadgeUrl
  const scan = (html: string, pageUrl?: string) => scanFeaturedBadge(html, expected, pageUrl)

  it('reads only the real href and rel, never text inside another attribute', () => {
    expect(
      scan(`<a title=" href=${L} " href="https://evil.example/"><img src="${B}"></a>`)
    ).toEqual({ code: 'wrong_destination', href: 'https://evil.example/', ok: false })
    expect(
      scan(`<a data-x=' href="${L}"' href="https://evil.example/"><img src="${B}"></a>`)
    ).toEqual({ code: 'wrong_destination', href: 'https://evil.example/', ok: false })
    expect(scan(`<a href="${L}" title='rel="me"' rel="nofollow"><img src="${B}"></a>`)).toEqual({
      code: 'link_not_followed',
      ok: false,
      rel: ['nofollow']
    })
    expect(scan(`<a href="${L}" title="rel=nofollow"><img src="${B}"></a>`)).toEqual({ ok: true })
    expect(scan(`<a data-href="${L}" href="https://evil.example/"><img src="${B}"></a>`)).toEqual({
      code: 'wrong_destination',
      href: 'https://evil.example/',
      ok: false
    })
  })

  it('needs a real img element, not markup inside an attribute or text', () => {
    expect(
      scan(`<a href="${L}"><img alt='<img src="${B}">' src="https://evil.example/x.png"></a>`)
    ).toEqual({ code: 'badge_missing', ok: false })
    expect(scan(`<a href="${L}"><span data-img='<img src="${B}">'>Featured</span></a>`)).toEqual({
      code: 'badge_missing',
      ok: false
    })
    expect(scan(`<a href="${L}">&lt;img src="${B}"&gt;</a>`)).toEqual({
      code: 'badge_missing',
      ok: false
    })
    expect(scan(`<a href="${L}"><img data-src="${B}"></a>`)).toEqual({
      code: 'badge_missing',
      ok: false
    })
    // The parser reads `<image>` as `<img>`.
    expect(scan(`<a href="${L}"><image src="${B}"></a>`)).toEqual({ ok: true })
  })

  it.each([
    ['a comment', `<!-- <a href="${L}"><img src="${B}"></a> -->`],
    ['an unclosed comment', `<!-- <a href="${L}"><img src="${B}"></a>`],
    ['a script string', `<script>document.write('<a href="${L}"><img src="${B}"></a>')</script>`],
    ['a template', `<template><a href="${L}"><img src="${B}"></a></template>`],
    [
      'a nested template',
      `<template><template></template><a href="${L}"><img src="${B}"></a></template>`
    ],
    ['noscript', `<noscript><a href="${L}"><img src="${B}"></a></noscript>`],
    ['a textarea', `<textarea><a href="${L}"><img src="${B}"></a></textarea>`],
    ['a style block', `<style>/* <a href="${L}"><img src="${B}"></a> */</style>`],
    ['a title', `<title><a href="${L}"><img src="${B}"></a></title>`],
    ['xmp', `<xmp><a href="${L}"><img src="${B}"></a></xmp>`],
    ['an iframe body', `<iframe><a href="${L}"><img src="${B}"></a></iframe>`],
    ['noembed', `<noembed><a href="${L}"><img src="${B}"></a></noembed>`],
    ['noframes', `<noframes><a href="${L}"><img src="${B}"></a></noframes>`],
    ['plaintext', `<plaintext><a href="${L}"><img src="${B}"></a>`],
    ['a CDATA section', `<![CDATA[<a href="${L}"><img src="${B}"></a>]]>`],
    ['an SVG link', `<svg><a href="${L}"><image href="${B}"></image></a></svg>`],
    ['a tag cut off at the end', `<a href="${L}"><img src="${B}"`]
  ])('ignores a badge in %s', (_label, html) => {
    expect(scan(html)).toMatchObject({ ok: false })
  })

  it('fails a real nofollow badge even with a followed copy in a comment', () => {
    const real = `<a rel="nofollow" href="${L}"><img src="${B}"></a>`
    const commented = `<!-- <a href="${L}"><img src="${B}"></a> -->`
    expect(scan(`${real}${commented}`)).toEqual({
      code: 'link_not_followed',
      ok: false,
      rel: ['nofollow']
    })
    expect(scan(`${commented}${real}`)).toMatchObject({ code: 'link_not_followed' })
    expect(scan(`${real}<script>'${validBadgeHtml}'</script>`)).toMatchObject({
      code: 'link_not_followed'
    })
  })

  it('finds the badge after raw text, comments, and templates end', () => {
    expect(scan(`<script>var a = "</scrip";</script>${validBadgeHtml}`)).toEqual({ ok: true })
    expect(scan(`<!-- x --!>${validBadgeHtml}`)).toEqual({ ok: true })
    expect(scan(`<!-->${validBadgeHtml}`)).toEqual({ ok: true })
    expect(scan(`<template><p></template>${validBadgeHtml}`)).toEqual({ ok: true })
    expect(scan(`<svg><path d="M0 0"/></svg>${validBadgeHtml}`)).toEqual({ ok: true })
    expect(scan(`<SCRIPT>x</SCRIPT ><A HREF="${L}"><IMG SRC="${B}"></A>`)).toEqual({ ok: true })
  })

  it('closes a link at the next link or its end tag', () => {
    // The badge is on the page but outside any link.
    expect(scan(`<a href="${L}"></a><img src="${B}">`)).toEqual({
      code: 'wrong_destination',
      ok: false
    })
    expect(scan(`<a href="${L}"><a href="https://evil.example/"><img src="${B}"></a>`)).toEqual({
      code: 'wrong_destination',
      href: 'https://evil.example/',
      ok: false
    })
  })

  it('resolves relative URLs against the page and its base element', () => {
    expect(
      scan(
        '<base href="https://best.serp.co/"><a href="/products/example.com/"><img src="/badge/featured-on-serp.co-light.svg"></a>',
        'https://example.com/'
      )
    ).toEqual({ ok: true })
    expect(
      scan(`<a href="/products/example.com/"><img src="${B}"></a>`, 'https://example.com/')
    ).toEqual({
      code: 'wrong_destination',
      href: 'https://example.com/products/example.com/',
      ok: false
    })
  })
})

describe('page-level nofollow', () => {
  it.each([
    '<meta name="robots" content="nofollow">',
    '<meta name="robots" content="noindex, nofollow">',
    '<META NAME="Robots" CONTENT="NoFollow">',
    '<meta name="googlebot" content="none">',
    '<meta content="nofollow" name="bingbot">'
  ])('fails a followed badge on a page with %s', meta => {
    expect(scanFeaturedBadge(`${meta}${validBadgeHtml}`, expected)).toEqual({
      code: 'page_not_followed',
      ok: false,
      source: 'meta'
    })
  })

  it('ignores robots meta that does not skip links, or that never renders', () => {
    for (const html of [
      '<meta name="robots" content="noindex">',
      '<meta name="description" content="nofollow">',
      '<!-- <meta name="robots" content="nofollow"> -->',
      '<template><meta name="robots" content="nofollow"></template>'
    ]) {
      expect(scanFeaturedBadge(`${html}${validBadgeHtml}`, expected), html).toEqual({ ok: true })
    }
    // Without a badge link to the listing, the missing badge is the problem to fix first.
    expect(
      scanFeaturedBadge('<meta name="robots" content="nofollow"><p>No badge</p>', expected)
    ).toEqual({ code: 'badge_missing', ok: false })
  })

  it('fails on an X-Robots-Tag header that skips links', async () => {
    for (const header of ['nofollow', 'noindex, nofollow', 'googlebot: none', 'NOFOLLOW']) {
      const page = async () =>
        new Response(validBadgeHtml, {
          headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': header },
          status: 200
        })
      await expect(
        verifyFeaturedBadge('https://example.com', expected, page),
        header
      ).resolves.toEqual({ code: 'page_not_followed', ok: false, source: 'header' })
    }
    const indexOnly = async () =>
      new Response(validBadgeHtml, {
        headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex, noarchive' },
        status: 200
      })
    await expect(verifyFeaturedBadge('https://example.com', expected, indexOnly)).resolves.toEqual({
      ok: true
    })
  })
})

describe('legacy listing URLs', () => {
  it('accepts badges that still link to the pre-simplification reviews URL', () => {
    const legacyHref = 'https://best.serp.co/products/example.com/reviews/'
    const html = `<a href="${legacyHref}"><img src="${lightBadgeUrl}"></a>`
    expect(scanFeaturedBadge(html, expected)).toEqual({
      ok: false,
      code: 'wrong_destination',
      href: legacyHref
    })
    expect(scanFeaturedBadge(html, { ...expected, legacyListingUrls: [legacyHref] })).toEqual({
      ok: true
    })
  })
})

describe('badge page fetch', () => {
  it('verifies a valid badge from fetched HTML', async () => {
    const badgePage = async () =>
      new Response(validBadgeHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        status: 200
      })

    await expect(verifyFeaturedBadge('https://example.com', expected, badgePage)).resolves.toEqual({
      ok: true
    })
  })

  it('distinguishes an unreachable website from a fetched page with no badge', async () => {
    const unreachableFetcher = async () => {
      throw new Error('workerd could not complete the request')
    }
    const fetchedPage = async () =>
      new Response('<html><body><p>No badge here.</p></body></html>', {
        headers: { 'Content-Type': 'text/html' },
        status: 200
      })

    await expect(
      verifyFeaturedBadge('https://unreachable.example', expected, unreachableFetcher)
    ).resolves.toEqual({ ok: false, code: 'site_unreachable' })
    await expect(
      verifyFeaturedBadge('https://reachable.example', expected, fetchedPage)
    ).resolves.toEqual({ ok: false, code: 'badge_missing' })
  })

  it('reports a verification timeout separately from other connection failures', async () => {
    const timedOutFetcher = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }

    await expect(
      verifyFeaturedBadge('https://slow.example', expected, timedOutFetcher)
    ).resolves.toEqual({ ok: false, code: 'fetch_timeout' })
  })

  it('preserves the public HTTP error status returned by the submitted website', async () => {
    const forbiddenFetcher = async () => new Response('Forbidden', { status: 403 })

    await expect(
      verifyFeaturedBadge('https://protected.example', expected, forbiddenFetcher)
    ).resolves.toEqual({ ok: false, code: 'http_403' })
  })

  it('distinguishes an invalid redirect from a redirect loop', async () => {
    const missingLocationFetcher = async () => new Response(null, { status: 302 })
    const redirectLoopFetcher = async () =>
      new Response(null, { headers: { Location: '/again' }, status: 302 })

    await expect(
      verifyFeaturedBadge('https://redirect.example', expected, missingLocationFetcher)
    ).resolves.toEqual({ ok: false, code: 'invalid_redirect' })
    await expect(
      verifyFeaturedBadge('https://loop.example', expected, redirectLoopFetcher)
    ).resolves.toEqual({ ok: false, code: 'too_many_redirects' })
  })

  it('does not blame the submitted website for an unexpected verifier failure', async () => {
    const failedVerifier = async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error('unexpected response stream failure')
          }
        }),
        { headers: { 'Content-Type': 'text/html' }, status: 200 }
      )

    await expect(
      verifyFeaturedBadge('https://reachable.example', expected, failedVerifier)
    ).resolves.toEqual({ ok: false, code: 'verification_service_error' })
  })

  it('reports responses that are unsafe or impossible to scan', async () => {
    const nonHtmlFetcher = async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 200 })
    const oversizedFetcher = async () =>
      new Response('<html></html>', {
        headers: { 'Content-Length': '1000001', 'Content-Type': 'text/html' },
        status: 200
      })

    await expect(
      verifyFeaturedBadge('http://127.0.0.1/', expected, nonHtmlFetcher)
    ).resolves.toEqual({ ok: false, code: 'invalid_target' })
    await expect(
      verifyFeaturedBadge('https://api.example', expected, nonHtmlFetcher)
    ).resolves.toEqual({ ok: false, code: 'not_html' })
    await expect(
      verifyFeaturedBadge('https://large.example', expected, oversizedFetcher)
    ).resolves.toEqual({ ok: false, code: 'response_too_large' })
  })
})
