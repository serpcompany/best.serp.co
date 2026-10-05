import { decodeEntities } from './prefill'
import { safeFetch } from './safe-fetch'

/**
 * Badge verification (serpcompany/best.serp.co#59): load the submitted website through the
 * safe fetcher (`./safe-fetch.ts`, which applies the shared public-URL policy to every
 * hop) and look for the Featured badge inside a plain, followed link to the listing.
 */
const MAX_HTML_BYTES = 1_000_000

/**
 * `rel` tokens that tell search engines not to follow or credit a link (owner decision on
 * #84). Any of them, in any case or order, fails the check as `link_not_followed`.
 */
export const UNFOLLOWED_REL_TOKENS = ['nofollow', 'sponsored', 'ugc'] as const
export type UnfollowedRelToken = (typeof UNFOLLOWED_REL_TOKENS)[number]

type ScanResult =
  | { ok: true }
  | { ok: false; code: 'badge_missing' }
  /** `rel`: the tokens that stop the badge link from being followed, in the order found. */
  | { code: 'link_not_followed'; ok: false; rel: UnfollowedRelToken[] }
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

/**
 * The first value of attribute `name` in `tag`, entities decoded, as a browser reads it. The
 * name must stand alone, so `data-rel` is never read as `rel`.
 */
function attribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  )
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value === undefined ? null : decodeEntities(value)
}

/** The unfollowed tokens in a `rel` value: split on whitespace, compared case-insensitively. */
export function unfollowedRelTokens(rel: string | null): UnfollowedRelToken[] {
  const tokens = (rel ?? '').toLowerCase().split(/\s+/u)
  return UNFOLLOWED_REL_TOKENS.filter(token => tokens.includes(token))
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

/**
 * Passes when any expected badge image sits inside a link to the listing with no unfollowed
 * `rel` token. Otherwise reports, in this order: a badge linking to the listing but not
 * followed (`link_not_followed`), a badge linking elsewhere (`wrong_destination`), or no badge.
 */
export function scanFeaturedBadge(html: string, expected: BadgeTargets): ScanResult {
  const expectedBadges = new Set(expected.badgeUrls.map(canonical))
  const expectedListings = new Set(
    [expected.listingUrl, ...(expected.legacyListingUrls ?? [])].map(canonical)
  )
  let sawBadge = false
  let wrongHref: string | null = null
  let unfollowed: UnfollowedRelToken[] | null = null

  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const anchor = match[0]
    const opening = anchor.match(/^<a\b[^>]*>/i)?.[0] ?? anchor
    const inner = match[1] ?? ''
    const href = attribute(opening, 'href')
    const hasBadge = [...inner.matchAll(/<img\b[^>]*>/gi)].some(image => {
      const src = attribute(image[0], 'src')
      if (!src) return false
      try {
        return expectedBadges.has(canonical(src))
      } catch {
        return false
      }
    })
    if (!hasBadge) continue
    sawBadge = true
    let toListing = false
    try {
      toListing = href !== null && expectedListings.has(canonical(href))
      if (!toListing && href !== null) wrongHref ??= new URL(href).toString()
    } catch {
      toListing = false
    }
    if (!toListing) continue
    const tokens = unfollowedRelTokens(attribute(opening, 'rel'))
    if (tokens.length === 0) return { ok: true }
    unfollowed ??= tokens
  }
  if (unfollowed) return { code: 'link_not_followed', ok: false, rel: unfollowed }
  if (sawBadge) {
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
