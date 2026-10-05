import { validatePublicHttpUrl } from '@serpdirectory/data-ops/public-url'
import { type SafeFetchFailure, safeFetch } from './safe-fetch'

/**
 * URL prefill for `/submit` (serpcompany/best.serp.co#59, #63), without AI: read the submitted
 * page's title, description, icons, and social image, and propose them. Every proposal stays
 * editable in the form. Logos are referenced by their public URL (the logo decision in
 * docs/SUBMISSION_FLOW.md), so a proposed image is fetched once to check that it is a PNG,
 * JPEG, WebP, or SVG image of at most 1 MB and, when its size can be read, at least 128 px on
 * its shorter side.
 */

export const MAX_PAGE_BYTES = 1_000_000
export const MAX_LOGO_BYTES = 1_000_000
export const MIN_LOGO_PIXELS = 128
export const SHORT_DESCRIPTION_MAX = 160
const MAX_NAME_LENGTH = 120
/** Icon candidates to try before giving up; each is one bounded fetch. */
const MAX_ICON_ATTEMPTS = 3

export type ImageFormat = 'jpeg' | 'png' | 'svg' | 'webp'

export interface ImageInfo {
  format: ImageFormat
  /** Null when the size cannot be read (SVG, or an unusual encoding). */
  height: number | null
  width: number | null
}

export type LogoCheck =
  | { image: ImageInfo; ok: true; url: string }
  | { code: 'logo_not_image' | 'logo_too_large' | 'logo_too_small' | 'logo_unreachable'; ok: false }

export type MetadataSource =
  | 'application-name'
  | 'meta description'
  | 'og:description'
  | 'og:site_name'
  | 'page title'
  | 'twitter:description'

export interface ProposedText {
  source: MetadataSource
  value: string
}

export interface SitePrefill {
  description: ProposedText | null
  /** The page's host, without `www.`, for the form's messages ("We filled in 3 fields from…"). */
  host: string
  name: ProposedText | null
  /** A checked site icon (largest first), or null. */
  siteIcon: string | null
  /** A checked social (Open Graph) image, or null. */
  socialImage: string | null
}

export type SitePrefillResult =
  | ({ ok: true } & SitePrefill)
  | { code: SafeFetchFailure; host: string; ok: false }

interface IconCandidate {
  href: string
  /** The larger declared side; null for `any` or undeclared. */
  size: number | null
  touch: boolean
  vector: boolean
}

export interface SiteMetadata {
  applicationName: string | null
  description: ProposedText | null
  icons: IconCandidate[]
  ogSiteName: string | null
  socialImage: string | null
  title: string | null
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’'
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null
  const text = decodeEntities(value)
    // Control characters and the replacement character never belong in a listing.
    .replace(/[\p{Cc}�]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text || null
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu')
  )
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

function absolute(href: string | null, base: string): string | null {
  const value = href?.trim()
  if (!value || value.startsWith('data:')) return null
  try {
    const url = new URL(decodeEntities(value), base)
    return validatePublicHttpUrl(url.toString()).ok ? url.toString() : null
  } catch {
    return null
  }
}

function declaredSize(sizes: string | null): number | null {
  if (!sizes) return null
  let largest: number | null = null
  for (const token of sizes.toLowerCase().split(/\s+/u)) {
    const match = token.match(/^(\d{1,5})x(\d{1,5})$/u)
    if (match) largest = Math.max(largest ?? 0, Math.min(Number(match[1]), Number(match[2])))
  }
  return largest
}

/** The document head (or the first 256 KB), where metadata lives. */
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>|<body[\s>]/iu)
  return (end === -1 ? html : html.slice(0, end)).slice(0, 256_000)
}

export function parseSiteMetadata(html: string, pageUrl: string): SiteMetadata {
  const head = headOf(html)
  const meta = new Map<string, string>()
  for (const match of head.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0]
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.trim().toLowerCase()
    const content = attribute(tag, 'content')
    if (key && content !== null && !meta.has(key)) meta.set(key, content)
  }
  const icons: IconCandidate[] = []
  for (const match of head.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0]
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/u)
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')
    if (!touch && !rel.includes('icon')) continue
    const href = absolute(attribute(tag, 'href'), pageUrl)
    if (!href) continue
    const type = (attribute(tag, 'type') ?? '').toLowerCase()
    const vector = type === 'image/svg+xml' || /\.svg(?:[?#]|$)/iu.test(href)
    // An apple-touch-icon without `sizes` is 180 × 180 by convention.
    icons.push({
      href,
      size: declaredSize(attribute(tag, 'sizes')) ?? (touch ? 180 : null),
      touch,
      vector
    })
  }
  const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1] ?? null
  const descriptionSources: Array<[string, MetadataSource]> = [
    ['description', 'meta description'],
    ['og:description', 'og:description'],
    ['twitter:description', 'twitter:description']
  ]
  let description: ProposedText | null = null
  for (const [key, source] of descriptionSources) {
    const value = clean(meta.get(key))
    if (value) {
      description = { source, value }
      break
    }
  }
  return {
    applicationName: clean(meta.get('application-name')),
    description,
    icons,
    ogSiteName: clean(meta.get('og:site_name')),
    socialImage:
      absolute(meta.get('og:image:secure_url') ?? null, pageUrl) ??
      absolute(meta.get('og:image') ?? null, pageUrl) ??
      absolute(meta.get('twitter:image') ?? null, pageUrl),
    title: clean(title)
  }
}

/** The product name: `og:site_name`, then `application-name`, then the title's first part. */
export function proposeName(metadata: SiteMetadata): ProposedText | null {
  const clampName = (value: string) => value.slice(0, MAX_NAME_LENGTH).trim()
  if (metadata.ogSiteName) return { source: 'og:site_name', value: clampName(metadata.ogSiteName) }
  if (metadata.applicationName) {
    return { source: 'application-name', value: clampName(metadata.applicationName) }
  }
  if (!metadata.title) return null
  const [first] = metadata.title.split(/\s+[|·•–—-]\s+|:\s+/u)
  const value = clampName(first || metadata.title)
  return value ? { source: 'page title', value } : null
}

/** Shortens a description to the 160-character limit at a word boundary, with an ellipsis. */
export function fitShortDescription(value: string): string {
  if (value.length <= SHORT_DESCRIPTION_MAX) return value
  const cut = value.slice(0, SHORT_DESCRIPTION_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > SHORT_DESCRIPTION_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, '')}…`
}

/** Site icons to try, best first: declared size (SVG counts as large), touch icons, then `/favicon`. */
export function iconCandidates(metadata: SiteMetadata, pageUrl: string): string[] {
  const ranked = [...metadata.icons].sort((a, b) => {
    const size = (icon: IconCandidate) => (icon.vector ? 10_000 : (icon.size ?? 0))
    return size(b) - size(a) || Number(b.touch) - Number(a.touch)
  })
  const hrefs = ranked
    .filter(icon => icon.vector || icon.size === null || icon.size >= MIN_LOGO_PIXELS)
    .map(icon => icon.href)
  const fallback = absolute('/apple-touch-icon.png', pageUrl)
  if (fallback) hrefs.push(fallback)
  return [...new Set(hrefs)]
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return uint16be(bytes, offset) * 65_536 + uint16be(bytes, offset + 2)
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function jpegSize(bytes: Uint8Array): { height: number; width: number } | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = uint16be(bytes, offset + 2)
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) return { height: uint16be(bytes, offset + 5), width: uint16be(bytes, offset + 7) }
    offset += 2 + length
  }
  return null
}

/** Identifies an image by its bytes (never by the server's content type) and reads its size. */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    return { format: 'png', height: uint32be(bytes, 20), width: uint32be(bytes, 16) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes)
    return { format: 'jpeg', height: size?.height ?? null, width: size?.width ?? null }
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === 'VP8X') {
      return { format: 'webp', height: uint24le(bytes, 27) + 1, width: uint24le(bytes, 24) + 1 }
    }
    if (chunk === 'VP8 ') {
      return {
        format: 'webp',
        height: (((bytes[29] ?? 0) << 8) | (bytes[28] ?? 0)) & 0x3fff,
        width: (((bytes[27] ?? 0) << 8) | (bytes[26] ?? 0)) & 0x3fff
      }
    }
    if (chunk === 'VP8L') {
      const b = (index: number) => bytes[21 + index] ?? 0
      return {
        format: 'webp',
        height: (((b(2) & 0xf0) >> 4) | (b(3) << 4) | ((b(4) & 0x03) << 12)) + 1,
        width: (b(0) | ((b(1) & 0x3f) << 8)) + 1
      }
    }
    return { format: 'webp', height: null, width: null }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096))
  if (
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/iu.test(
      text
    )
  ) {
    return { format: 'svg', height: null, width: null }
  }
  return null
}

/**
 * Checks that `url` is a usable logo: a public URL that answers with a PNG, JPEG, WebP, or SVG
 * image of at most 1 MB, at least 128 px on its shorter side when the size can be read.
 */
export async function checkLogoUrl(url: string, fetcher: typeof fetch = fetch): Promise<LogoCheck> {
  const result = await safeFetch(url, {
    // The bytes decide the format; servers often label images loosely.
    accept: type => type === '' || type.startsWith('image/') || type === 'application/octet-stream',
    acceptHeader: 'image/png,image/jpeg,image/webp,image/svg+xml;q=0.9,image/*;q=0.5',
    fetcher,
    maxBytes: MAX_LOGO_BYTES
  })
  if (!result.ok) {
    if (result.code === 'response_too_large') return { code: 'logo_too_large', ok: false }
    if (result.code === 'unexpected_type') return { code: 'logo_not_image', ok: false }
    return { code: 'logo_unreachable', ok: false }
  }
  const image = inspectImage(result.body)
  if (!image) return { code: 'logo_not_image', ok: false }
  if (
    image.width !== null &&
    image.height !== null &&
    Math.min(image.width, image.height) < MIN_LOGO_PIXELS
  ) {
    return { code: 'logo_too_small', ok: false }
  }
  return { image, ok: true, url: result.url }
}

export function displayHost(website: string): string {
  try {
    return new URL(website).hostname.replace(/^www\./u, '')
  } catch {
    return website
  }
}

/** Reads the page at `website` and proposes the form's fields (see the module comment). */
export async function readSitePrefill(
  website: string,
  fetcher: typeof fetch = fetch
): Promise<SitePrefillResult> {
  const host = displayHost(website)
  const page = await safeFetch(website, {
    accept: type => type === 'text/html' || type === 'application/xhtml+xml',
    acceptHeader: 'text/html,application/xhtml+xml',
    fetcher,
    maxBytes: MAX_PAGE_BYTES
  })
  if (!page.ok) return { code: page.code, host, ok: false }
  const metadata = parseSiteMetadata(new TextDecoder().decode(page.body), page.url)

  let siteIcon: string | null = null
  for (const candidate of iconCandidates(metadata, page.url).slice(0, MAX_ICON_ATTEMPTS)) {
    const checked = await checkLogoUrl(candidate, fetcher)
    if (checked.ok) {
      siteIcon = candidate
      break
    }
  }
  const social = metadata.socialImage ? await checkLogoUrl(metadata.socialImage, fetcher) : null

  return {
    description: metadata.description
      ? { ...metadata.description, value: fitShortDescription(metadata.description.value) }
      : null,
    host,
    name: proposeName(metadata),
    ok: true,
    siteIcon,
    socialImage: social?.ok && metadata.socialImage ? metadata.socialImage : null
  }
}
