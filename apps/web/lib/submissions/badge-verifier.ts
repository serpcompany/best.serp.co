import type { DefaultTreeAdapterMap } from 'parse5'
import { parseBoundedHtml } from './bounded-html'
import {
  declaredEncodings,
  decodeHtml,
  decodeWith,
  encodingForLabel,
  extractMimeType,
  metaContentEncoding,
  metaEncoding,
  splitHeaderValue
} from './html-encoding'
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
 * The page is decoded as a browser decodes it (`./html-encoding.ts`: byte order mark, then the
 * `Content-Type` charset, then a `<meta>` declaration, then UTF-8), and a page a browser
 * would download (`Content-Disposition` other than `inline`) or can't show (the
 * `replacement` encoding) fails as `not_html` (PR #84 review round 3, finding 1). Wherever
 * the page's type or encoding is ambiguous, it fails closed as `not_html` too (round 4):
 * `Content-Type` or `Content-Disposition` values that disagree, and `<meta>` declarations
 * that disagree or that no `<meta>` in `<head>` confirms (`settleMetaEncoding`).
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
/**
 * The crawlers whose robots rules count: the general rules (`<meta name="robots">`, or an
 * `X-Robots-Tag` directive with no user-agent prefix) and Googlebot's. A rule for any other
 * crawler (`otherbot: nofollow`) does not fail the check.
 */
const ROBOTS_META_NAMES = new Set(['robots', 'googlebot'])
const ROBOTS_HEADER_AGENTS = new Set(['googlebot'])
/** `X-Robots-Tag` directives whose own value follows a colon, so the colon is not an agent. */
const VALUED_ROBOTS_DIRECTIVES = new Set([
  'max-image-preview',
  'max-snippet',
  'max-video-preview',
  'unavailable_after'
])

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

/** True when directives (`noindex, nofollow`, `noindex nofollow`, `none`) skip links. */
function directivesSkipLinks(directives: string): boolean {
  return directives
    .toLowerCase()
    .split(/[\s,]+/u)
    .some(token => UNFOLLOWED_ROBOTS_DIRECTIVES.has(token))
}

/** True when a robots meta `content` skips links. */
export function robotsMetaSkipsLinks(content: string | null | undefined): boolean {
  return directivesSkipLinks(content ?? '')
}

/**
 * True when an `X-Robots-Tag` value skips links for the crawlers that count: a `nofollow` or
 * `none` directive with no user-agent prefix, or with a `googlebot:` prefix. A prefix covers
 * only its own comma-separated directive (PR #84 review round 3, owner rule): a fetch joins
 * repeated headers with commas, so `otherbot: noarchive` and a separate `nofollow` header
 * arrive as `otherbot: noarchive, nofollow`, and Google applies that `nofollow` to every
 * crawler. Reading every unprefixed directive as one for all crawlers errs the way Google
 * does, at the cost of failing a single `otherbot: noindex, nofollow` header (which
 * `otherbot: noindex, otherbot: nofollow` avoids). Directives with their own colon value
 * (`max-snippet: 20`) are not prefixes.
 */
export function robotsHeaderSkipsLinks(value: string | null | undefined): boolean {
  for (const part of (value ?? '').split(',')) {
    let agent: string | null = null
    let directive = part.trim()
    const prefix = /^([a-z0-9_.-]+)\s*:\s*(.*)$/iu.exec(directive)
    if (prefix?.[1] && !VALUED_ROBOTS_DIRECTIVES.has(prefix[1].toLowerCase())) {
      agent = prefix[1].toLowerCase()
      directive = prefix[2] ?? ''
    }
    const applies = agent === null || ROBOTS_HEADER_AGENTS.has(agent)
    if (applies && directivesSkipLinks(directive)) return true
  }
  return false
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

type Template = DefaultTreeAdapterMap['template']

/** The encoding a `<meta>` element declares, by the prescan's rules, or null. */
function metaElementEncoding(meta: Element): string | null {
  const charset = attribute(meta, 'charset')
  if (charset !== undefined) {
    const encoding = encodingForLabel(charset)
    return encoding && metaEncoding(encoding)
  }
  if (attribute(meta, 'http-equiv')?.trim().toLowerCase() !== 'content-type') return null
  const encoding = metaContentEncoding((attribute(meta, 'content') ?? '').toLowerCase())
  return encoding && metaEncoding(encoding)
}

/**
 * The encodings the page's `<meta>` elements declare: the first one the parser placed in
 * `<head>` (what Chromium's head-bounded scan finds), and all of them, in `<template>`
 * contents and `<body>` too.
 */
function treeMetaEncodings(document: ParentNode): { all: Set<string>; head: string | null } {
  const all = new Set<string>()
  const htmlElement = childElements(document).find(element => isHtml(element, 'html'))
  const headElement =
    htmlElement && childElements(htmlElement).find(element => isHtml(element, 'head'))
  let head: string | null = null
  for (const element of headElement ? childElements(headElement) : []) {
    head = isHtml(element, 'meta') ? metaElementEncoding(element) : null
    if (head) break
  }
  const stack: ParentNode[] = [document]
  while (stack.length > 0) {
    for (const element of childElements(stack.pop() as ParentNode)) {
      const encoding = isHtml(element, 'meta') ? metaElementEncoding(element) : null
      if (encoding) all.add(encoding)
      stack.push(element)
      if (isHtml(element, 'template')) stack.push((element as Template).content)
    }
  }
  return { all, head }
}

/**
 * For a page whose encoding came from a `<meta>` in its first 1024 bytes or the UTF-8 default
 * (not a BOM or the header), the parsed document to scan, or null to fail closed (PR #84
 * review round 4). Chromium keeps looking for a `<meta>` past 1024 bytes while it is in
 * `<head>`, and skips text in `<script>`, `<style>`, `<title>` or `<textarea>`. So every
 * declaration in the page (`declaredEncodings` over the bytes, and every `<meta>` element the
 * parser built) must name one encoding, and the first `<meta>` in `<head>` must name it too,
 * unless it is UTF-8, the default either way. If it isn't the one decoded with, the page is
 * decoded with it once and parsed again, and must then say the same.
 */
function settleMetaEncoding(
  bytes: Uint8Array,
  decodedWith: string,
  document: ParentNode
): ParentNode | null {
  const tree = treeMetaEncodings(document)
  const declared = new Set([...declaredEncodings(bytes), ...tree.all])
  if (declared.size === 0) return decodedWith === 'utf-8' ? document : null
  const [encoding] = declared
  if (declared.size > 1 || encoding === undefined) return null
  if (tree.head !== encoding && encoding !== 'utf-8') return null
  if (encoding === decodedWith) return document
  const html = decodeWith(bytes, encoding)
  if (html === null) return null
  const again = parseBoundedHtml(html).document
  const check = treeMetaEncodings(again)
  if ((check.head ?? 'utf-8') !== encoding || [...check.all].some(item => item !== encoding)) {
    return null
  }
  return again
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
  return scanDocument(parseBoundedHtml(html).document, expected, pageUrl)
}

function scanDocument(
  document: ParentNode,
  expected: BadgeTargets,
  pageUrl: string | undefined
): ScanResult {
  const expectedBadges = new Set(expected.badgeUrls.map(url => canonical(url, undefined)))
  const expectedListings = new Set(
    [expected.listingUrl, ...(expected.legacyListingUrls ?? [])].map(url =>
      canonical(url, undefined)
    )
  )
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
        if (
          name &&
          ROBOTS_META_NAMES.has(name) &&
          robotsMetaSkipsLinks(attribute(element, 'content'))
        ) {
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

/**
 * True when a browser would download the response instead of showing it, or might: a
 * `Content-Disposition` whose type is a token other than `inline` (Chromium treats an unknown
 * type as `attachment`, and a header that starts with a parameter as `inline`), or several
 * values (a comma outside a quoted string: repeated headers arrive joined, and Chromium
 * refuses a response whose values differ).
 */
export function isDownload(contentDisposition: string | null | undefined): boolean {
  if (contentDisposition === null || contentDisposition === undefined) return false
  if (splitHeaderValue(contentDisposition).length > 1) return true
  const type = contentDisposition.split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(type) && type !== 'inline'
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
  if (isDownload(page.headers.get('content-disposition'))) return { ok: false, code: 'not_html' }
  const mime = extractMimeType(page.headers.get('content-type'))
  if (mime?.essence !== 'text/html') return { ok: false, code: 'not_html' }
  const decoded = decodeHtml(page.body, mime.charset)
  if (!decoded) return { ok: false, code: 'not_html' }
  let result: ScanResult
  try {
    let document: ParentNode | null = parseBoundedHtml(decoded.html).document
    if (decoded.source === 'meta' || decoded.source === 'default') {
      document = settleMetaEncoding(page.body, decoded.encoding, document)
    }
    if (!document) return { ok: false, code: 'not_html' }
    result = scanDocument(document, expected, page.url)
  } catch {
    return { ok: false, code: 'verification_service_error' }
  }
  const headerSkipsLinks = robotsHeaderSkipsLinks(page.headers.get('x-robots-tag'))
  if (headerSkipsLinks && (result.ok || result.code === 'link_not_followed')) {
    return { code: 'page_not_followed', ok: false, source: 'header' }
  }
  return result
}
