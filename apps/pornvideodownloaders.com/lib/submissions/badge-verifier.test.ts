import { describe, expect, it } from 'vitest'
import { scanFeaturedBadge, verifyFeaturedBadge } from './badge-verifier'

const expected = {
  badgeUrls: [
    'https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-light.svg',
    'https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-dark.svg'
  ],
  listingUrl: 'https://pornvideodownloaders.com/products/example.com'
}

describe('badge scanner', () => {
  it('requires the expected image inside a dofollow listing link', () => {
    expect(
      scanFeaturedBadge(
        '<a href="https://pornvideodownloaders.com/products/example.com"><img src="https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-light.svg"></a>',
        expected
      )
    ).toEqual({ ok: true })
    expect(
      scanFeaturedBadge(
        '<a rel="nofollow" href="https://pornvideodownloaders.com/products/example.com"><img src="https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-light.svg"></a>',
        expected
      )
    ).toEqual({ ok: false, code: 'nofollow' })
  })

  it('rejects the wrong destination and absent badge', () => {
    expect(
      scanFeaturedBadge(
        '<a href="https://pornvideodownloaders.com/"><img src="https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-light.svg"></a>',
        expected
      )
    ).toEqual({ ok: false, code: 'wrong_destination' })
    expect(scanFeaturedBadge('<p>No badge</p>', expected)).toEqual({
      ok: false,
      code: 'badge_missing'
    })
  })
})

describe('badge page fetch', () => {
  it('verifies a valid badge from fetched HTML', async () => {
    const badgePage = async () =>
      new Response(
        '<a href="https://pornvideodownloaders.com/products/example.com"><img src="https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-light.svg"></a>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 }
      )

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
