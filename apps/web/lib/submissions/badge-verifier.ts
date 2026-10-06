import type { DefaultTreeAdapterMap } from 'parse5'
import { parseBoundedHtml } from './bounded-html'
import { safeFetch } from './safe-fetch'

/**
 * Badge verification (serpcompany/best.serp.co#59): load the submitted website through the
 * safe fetcher (`./safe-fetch.ts`, which applies the shared public-URL policy to every hop),
 * parse it with `parse5` (the WHATWG HTML tokenizer and tree builder, as a browser does, with
 * scripting on as for Googlebot), and look in the resulting tree for the Featured badge: an
 * HTML `<img>` of one of the badge URLs whose nearest link ancestor is an HTML `<a>` whose
 * `href` is the listing and whose `rel` has no `nofollow`, `sponsored`, or `ugc` (owner decision
 * on #84), on a page that does not tell crawlers to skip its links.
 *
 * Because the tree is the browser's tree, comments, raw text (`script`, `style`, `noscript`,
 * `textarea`, `title`, …), CDATA, `<template>` contents (a separate fragment), and SVG or
 * MathML foreign content are handled exactly as a browser handles them (PR #84 review round 2,
 * finding 1). The parse runs within the CPU and memory limits in `./bounded-html.ts`
 * (finding 2); a page past them fails as `verification_service_error`, which does not use up
 * a check. Relative URLs resolve against the page URL, or the first HTML `<base href>` the
 * parser placed in `<head>`.
 *
 * Only the static HTML is read: a badge added by JavaScript fails, and a badge hidden with CSS
 * (`display:none`) passes, because detecting it would need rendering. That is accepted.
 */
const MAX_HTML_BYTES = 1_000_000
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

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

type ParentNode = DefaultTreeAdapterMap['parentNode']
type Element = DefaultTreeAdapterMap['element']
type ChildNode = DefaultTreeAdapterMap['childNode']

/** The unfollowed tokens in a `rel` value: split on ASCII whitespace, case-insensitive. */
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
  const url = new URL(value, base)
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find(attr => attr.name === name && !attr.namespace)?.value
}

function isHtml(element: Element, tagName: string): boolean {
  return element.tagName === tagName && element.namespaceURI === HTML_NAMESPACE
}

function childElements(node: ParentNode): Element[] {
  return (node.childNodes as ChildNode[]).filter(
    (child): child is Element => 'tagName' in child && typeof child.tagName === 'string'
  )
}

/** The first HTML `<base href>` the parser placed in `<head>`, resolved against the page. */
function documentBase(document: ParentNode, pageUrl: string | undefined): string | undefined {
  const htmlElement = childElements(document).find(element => isHtml(element, 'html'))
  const head = htmlElement && childElements(htmlElement).find(element => isHtml(element, 'head'))
  const base =
    head &&
    childElements(head).find(
      element => isHtml(element, 'base') && attribute(element, 'href') !== undefined
    )
  if (!base) return pageUrl
  try {
    return new URL(attribute(base, 'href') ?? '', pageUrl).toString()
  } catch {
    return pageUrl
  }
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
 * (`wrong_destination`), or no badge. `pageUrl` resolves relative URLs. Throws
 * `HtmlTooComplexError` for a page past the parser's limits.
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
  const { document } = parseBoundedHtml(html)
  const base = documentBase(document, pageUrl)
  const resolve = (value: string | undefined): string | null => {
    if (value === undefined) return null
    try {
      return canonical(value, base)
    } catch {
      return null
    }
  }

  let sawBadge = false
  let followed = false
  let wrongHref: string | null = null
  let unfollowed: UnfollowedRelToken[] | null = null
  let pageSkipsLinks = false

  // Depth-first, iteratively (a page can nest deeply), carrying the nearest link ancestor.
  // `<template>` contents live in a separate fragment (`content`), so they are never visited.
  const stack: Array<{ link: Element | null; node: ParentNode }> = [{ link: null, node: document }]
  while (stack.length > 0) {
    const { link, node } = stack.pop() as { link: Element | null; node: ParentNode }
    const children = childElements(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const element = children[index] as Element
      // The nearest `<a>` of any namespace: an SVG link inside an HTML one wins (fail closed).
      const nearestLink = element.tagName === 'a' ? element : link
      if (isHtml(element, 'meta')) {
        const name = attribute(element, 'name')?.trim().toLowerCase()
        if (name && ROBOTS_META_NAMES.has(name) && robotsSkipLinks(attribute(element, 'content'))) {
          pageSkipsLinks = true
        }
      } else if (isHtml(element, 'img') && nearestLink) {
        const src = resolve(attribute(element, 'src'))
        if (src && expectedBadges.has(src)) {
          sawBadge = true
          const rawHref =
            nearestLink.namespaceURI === HTML_NAMESPACE ? attribute(nearestLink, 'href') : undefined
          const href = resolve(rawHref)
          if (href && expectedListings.has(href)) {
            const tokens = unfollowedRelTokens(attribute(nearestLink, 'rel'))
            if (tokens.length === 0) followed = true
            else unfollowed ??= tokens
          } else if (href && rawHref !== undefined) {
            try {
              wrongHref ??= new URL(rawHref, base).toString()
            } catch {
              // An unusable href stays unnamed.
            }
          }
        }
      } else if (isHtml(element, 'img')) {
        const src = resolve(attribute(element, 'src'))
        if (src && expectedBadges.has(src)) sawBadge = true
      }
      stack.push({ link: nearestLink, node: element })
    }
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
