import { safeFetch } from './safe-fetch'

/**
 * Badge verification (serpcompany/best.serp.co#59): load the submitted website through the
 * safe fetcher (`./safe-fetch.ts`, which applies the shared public-URL policy to every
 * hop) and look for the Featured badge inside a dofollow link to the listing.
 */
const MAX_HTML_BYTES = 1_000_000

type ScanResult =
  | { ok: true }
  | { ok: false; code: 'badge_missing' | 'nofollow' }
  /** `href`: where the first misdirected badge links, when it is an absolute URL. */
  | { href?: string; ok: false; code: 'wrong_destination' }

export type BadgeVerificationResult =
  | ScanResult
  | {
      ok: false
      code:
        | 'fetch_timeout'
        | 'invalid_target'
        | 'invalid_redirect'
        | 'not_html'
        | 'response_too_large'
        | 'site_unreachable'
        | 'too_many_redirects'
        | 'verification_service_error'
        | `http_${number}`
    }

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function canonical(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export interface BadgeTargets {
  badgeUrls: readonly string[]
  /** Earlier listing URLs that now redirect to `listingUrl` and still count as correct. */
  legacyListingUrls?: readonly string[]
  listingUrl: string
}

export function scanFeaturedBadge(html: string, expected: BadgeTargets): ScanResult {
  const expectedBadges = new Set(expected.badgeUrls.map(canonical))
  const expectedListings = new Set(
    [expected.listingUrl, ...(expected.legacyListingUrls ?? [])].map(canonical)
  )
  let sawBadge = false
  let sawWrongDestination = false
  let wrongHref: string | null = null

  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const anchor = match[0]
    const inner = match[1]
    const href = attribute(anchor, 'href')
    for (const image of inner.matchAll(/<img\b[^>]*>/gi)) {
      const src = attribute(image[0], 'src')
      if (!src) continue
      let isExpected = false
      try {
        isExpected = expectedBadges.has(canonical(src))
      } catch {
        continue
      }
      if (!isExpected) continue
      sawBadge = true
      if (!href) {
        sawWrongDestination = true
        continue
      }
      try {
        if (!expectedListings.has(canonical(href))) {
          sawWrongDestination = true
          wrongHref ??= new URL(href).toString()
          continue
        }
      } catch {
        sawWrongDestination = true
        continue
      }
      const rel = (attribute(anchor, 'rel') || '').toLowerCase().split(/\s+/)
      if (rel.includes('nofollow')) return { ok: false, code: 'nofollow' }
      return { ok: true }
    }
  }
  if (sawBadge || sawWrongDestination) {
    return { ok: false, code: 'wrong_destination', ...(wrongHref ? { href: wrongHref } : {}) }
  }
  return { ok: false, code: 'badge_missing' }
}

export async function verifyFeaturedBadge(
  website: string,
  expected: BadgeTargets,
  fetcher: typeof fetch = fetch
): Promise<BadgeVerificationResult> {
  const page = await safeFetch(website, {
    accept: type => type === 'text/html',
    acceptHeader: 'text/html',
    fetcher,
    maxBytes: MAX_HTML_BYTES
  })
  if (!page.ok) {
    if (page.code === 'unexpected_type') return { ok: false, code: 'not_html' }
    if (page.code === 'read_failed') return { ok: false, code: 'verification_service_error' }
    return { ok: false, code: page.code }
  }
  try {
    return scanFeaturedBadge(new TextDecoder().decode(page.body), expected)
  } catch {
    return { ok: false, code: 'verification_service_error' }
  }
}
