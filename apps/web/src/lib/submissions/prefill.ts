import { type SafeFetchFailure, safeFetch } from '../../db/safe-fetch'
import {
  iconCandidates,
  type ProposedText,
  parseSiteMetadata,
  type SiteMetadata
} from '../../db/site-metadata'

// The page parser is shared with media ingestion (#95); the form-specific proposals stay here.
export {
  decodeEntities,
  iconCandidates,
  type MetadataSource,
  type ProposedText,
  parseSiteMetadata,
  type SiteMetadata
} from '../../db/site-metadata'

/**
 * URL prefill for `/submit` (serpcompany/best.serp.co#59, #63), without AI: read the submitted
 * page's title, description, icons, and social image, and propose them. Every proposal stays
 * editable in the form. A proposed or pasted logo is fetched once to check that it is a PNG,
 * JPEG, or WebP image of at most 1 MB and, when its size can be read, at least 128 px on its
 * shorter side. An SVG is refused (#95: logos are copied to our media host, which never serves
 * SVG); the saved logo is then hosted under the submission (`hostSubmissionMedia`).
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
 * Checks that `url` is a usable logo: a public URL that answers with a PNG, JPEG, or WebP image
 * of at most 1 MB, at least 128 px on its shorter side when the size can be read. `inspectImage`
 * still recognizes SVG so that it is refused here by name, never hosted.
 */
export async function checkLogoUrl(url: string, fetcher: typeof fetch = fetch): Promise<LogoCheck> {
  const result = await safeFetch(url, {
    // The bytes decide the format; servers often label images loosely.
    accept: type => type === '' || type.startsWith('image/') || type === 'application/octet-stream',
    acceptHeader: 'image/png,image/jpeg,image/webp,image/*;q=0.5',
    fetcher,
    maxBytes: MAX_LOGO_BYTES
  })
  if (!result.ok) {
    if (result.code === 'response_too_large') return { code: 'logo_too_large', ok: false }
    if (result.code === 'unexpected_type') return { code: 'logo_not_image', ok: false }
    return { code: 'logo_unreachable', ok: false }
  }
  const image = inspectImage(result.body)
  if (!image || image.format === 'svg') return { code: 'logo_not_image', ok: false }
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
  fetcher: typeof fetch = fetch,
  options: {
    /** Propose http images too (a local Worker only); otherwise only https images. */
    allowInsecureLogos?: boolean
  } = {}
): Promise<SitePrefillResult> {
  const usableImage = (url: string) =>
    url.startsWith('https:') || (options.allowInsecureLogos === true && url.startsWith('http:'))
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
  // SVG icons are skipped: a logo is hosted, and the media host never takes SVG (#95).
  const candidates = iconCandidates(metadata, page.url, { vector: false }).filter(usableImage)
  for (const candidate of candidates.slice(0, MAX_ICON_ATTEMPTS)) {
    const checked = await checkLogoUrl(candidate, fetcher)
    if (checked.ok) {
      siteIcon = candidate
      break
    }
  }
  const socialImage =
    metadata.socialImage && usableImage(metadata.socialImage) ? metadata.socialImage : null
  const social = socialImage ? await checkLogoUrl(socialImage, fetcher) : null

  return {
    description: metadata.description
      ? { ...metadata.description, value: fitShortDescription(metadata.description.value) }
      : null,
    host,
    name: proposeName(metadata),
    ok: true,
    siteIcon,
    socialImage: social?.ok && socialImage ? socialImage : null
  }
}
