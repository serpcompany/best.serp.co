import { htmlTags } from './html-tokens'
import { safeFetch } from './safe-fetch'

/**
 * Badge verification (serpcompany/best.serp.co#59): load the submitted website through the
 * safe fetcher (`./safe-fetch.ts`, which applies the shared public-URL policy to every hop)
 * and look, in the tags a browser would render (`./html-tokens.ts`), for the Featured badge:
 * a real `<img>` of one of the badge URLs inside an `<a>` whose own `href` is the listing and
 * whose own `rel` has no `nofollow`, `sponsored`, or `ugc` (owner decision on #84), on a page
 * that does not tell crawlers to skip its links (`<meta name="robots" content="nofollow">` or
 * an `X-Robots-Tag: nofollow` header).
 *
 * Only the static HTML is read: a badge added by JavaScript fails, and a badge hidden with CSS
 * (`display:none`) passes, because detecting it would need rendering. That is accepted.
 */
const MAX_HTML_BYTES = 1_000_000

/**
 * `rel` tokens that tell search engines not to follow or credit a link (owner decision on
 * #84). Any of them, in any case or order, fails the check as `link_not_followed`.
 */
export const UNFOLLOWED_REL_TOKENS = ['nofollow', 'sponsored', 'ugc'] as const
export type UnfollowedRelToken = (typeof UNFOLLOWED_REL_TOKENS)[number]

/** Robots directives that stop crawlers following every link on a page. */
const UNFOLLOWED_ROBOTS_DIRECTIVES = new Set(['nofollow', 'none'])
/** `<meta name>` values whose robots directives major crawlers obey. */
const ROBOTS_META_NAMES = new Set(['robots', 'googlebot', 'bingbot'])

type ScanResult =
  | { ok: true }
  | { ok: false; code: 'badge_missing' }
  /** `rel`: the tokens that stop the badge link from being followed, in the order found. */
  | { code: 'link_not_followed'; ok: false; rel: UnfollowedRelToken[] }
  /** The whole page asks crawlers not to follow its links: by a robots meta tag or header. */
  | { code: 'page_not_followed'; ok: false; source: 'header' | 'meta' }
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

/** The unfollowed tokens in a `rel` value: split on whitespace, compared case-insensitively. */
export function unfollowedRelTokens(rel: string | null | undefined): UnfollowedRelToken[] {
  const tokens = (rel ?? '').toLowerCase().split(/[\t\n\f\r ]+/u)
  return UNFOLLOWED_REL_TOKENS.filter(token => tokens.includes(token))
}

/** True when a robots directive list (`noindex, nofollow`, `googlebot: none`) skips links. */
export function robotsSkipLinks(value: string | null | undefined): boolean {
  return (value ?? '')
    .toLowerCase()
    .split(/[\s,:]+/u)
    .some(directive => UNFOLLOWED_ROBOTS_DIRECTIVES.has(directive))
}

function canonical(value: string, base: string | undefined): string {
  const url = new URL(value.trim(), base)
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
 * `rel` token on a page that does not skip links. Otherwise reports, in this order: the page
 * skips links (`page_not_followed`, only when a badge links to the listing), a badge linking to
 * the listing but not followed (`link_not_followed`), a badge linking elsewhere
 * (`wrong_destination`), or no badge. `pageUrl` resolves relative URLs (with `<base href>`).
 */
export function scanFeaturedBadge(
  html: string,
  expected: BadgeTargets,
  pageUrl?: string
): ScanResult {
  const expectedBadges = new Set(expected.badgeUrls.map(url => canonical(url, undefined)))
  const expectedListings = new Set(
    [expected.listingUrl, ...(expected.legacyListingUrls ?? [])].map(url =>
      canonical(url, undefined)
    )
  )
  let base = pageUrl
  let sawBase = false
  let anchor: ReadonlyMap<string, string> | null = null
  let sawBadge = false
  let followed = false
  let wrongHref: string | null = null
  let unfollowed: UnfollowedRelToken[] | null = null
  let pageSkipsLinks = false

  const resolve = (value: string | undefined): string | null => {
    if (value === undefined) return null
    try {
      return canonical(value, base)
    } catch {
      return null
    }
  }

  const absolute = (value: string | undefined): string | null => {
    try {
      return value === undefined ? null : new URL(value.trim(), base).toString()
    } catch {
      return null
    }
  }

  for (const tag of htmlTags(html)) {
    if (tag.kind === 'end') {
      if (tag.name === 'a' && !tag.inForeignContent) anchor = null
      continue
    }
    if (tag.name === 'base' && !sawBase && tag.attributes.has('href')) {
      sawBase = true
      try {
        base = new URL(tag.attributes.get('href') ?? '', pageUrl).toString()
      } catch {
        // An unusable base leaves relative URLs resolving against the page.
      }
      continue
    }
    if (tag.name === 'meta') {
      const name = tag.attributes.get('name')?.trim().toLowerCase()
      if (name && ROBOTS_META_NAMES.has(name) && robotsSkipLinks(tag.attributes.get('content'))) {
        pageSkipsLinks = true
      }
      continue
    }
    if (tag.name === 'a') {
      // An `<a>` inside `<svg>` or `<math>` is not an HTML link; a new `<a>` closes the last.
      anchor = tag.inForeignContent ? null : tag.attributes
      continue
    }
    // The parser reads `<image>` as `<img>`.
    if ((tag.name !== 'img' && tag.name !== 'image') || tag.inForeignContent || !anchor) continue
    const src = resolve(tag.attributes.get('src'))
    if (!src || !expectedBadges.has(src)) continue
    sawBadge = true
    const href = resolve(anchor.get('href'))
    if (!href || !expectedListings.has(href)) {
      if (href) wrongHref ??= absolute(anchor.get('href'))
      continue
    }
    const tokens = unfollowedRelTokens(anchor.get('rel'))
    if (tokens.length === 0) followed = true
    else unfollowed ??= tokens
  }

  const linksToListing = followed || unfollowed !== null
  if (linksToListing && pageSkipsLinks) {
    return { code: 'page_not_followed', ok: false, source: 'meta' }
  }
  if (followed) return { ok: true }
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
  let result: ScanResult
  try {
    result = scanFeaturedBadge(new TextDecoder().decode(page.body), expected, page.url)
  } catch {
    return { ok: false, code: 'verification_service_error' }
  }
  const headerSkipsLinks = robotsSkipLinks(page.headers.get('x-robots-tag'))
  if (headerSkipsLinks && (result.ok || result.code === 'link_not_followed')) {
    return { code: 'page_not_followed', ok: false, source: 'header' }
  }
  return result
}
