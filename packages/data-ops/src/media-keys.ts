import { type HostedImageFormat, IMAGE_CONTENT_TYPES, IMAGE_EXTENSIONS } from './media-format'

/**
 * Hosted listing media (serpcompany/best.serp.co#95). Every listing image lives in the
 * environment's R2 bucket under a content-addressed, immutable key, and D1 stores that key, never
 * a URL. Pages build the URL from the environment's media host (`MEDIA_BASE_URL`), so one
 * publication manifest fits staging and production.
 */

/** The prefix this site owns in the shared bucket; nothing outside it is ever written. */
export const MEDIA_SITE = 'best.serp.co'
export const MEDIA_KINDS = ['logo', 'image'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable'
/** The local Worker serves its R2 binding here (never on staging or in production). */
export const LOCAL_MEDIA_PATH = '/_media'
/** Hex characters of the SHA-256 digest kept in the key. */
export const MEDIA_HASH_LENGTH = 16

/** The metadata D1 records for a hosted image, next to its key. */
export interface HostedMedia {
  bytes: number
  contentType: string
  height: number
  key: string
  sha256: string
  /** Where the bytes came from (provenance); never rendered. */
  sourceUrl: string
  width: number
}

const slugPattern = /^[a-z0-9][a-z0-9._-]*$/u
const keyPattern = new RegExp(
  `^${MEDIA_SITE.replaceAll('.', '\\.')}/listings/([a-z0-9][a-z0-9._-]*)/(logo|image)/([0-9a-f]{${MEDIA_HASH_LENGTH}})\\.(png|jpg|webp|gif|avif|ico)$`,
  'u'
)

export function mediaKey(input: {
  format: HostedImageFormat
  kind: MediaKind
  sha256: string
  slug: string
}): string {
  if (!slugPattern.test(input.slug)) throw new Error(`Invalid listing slug for a media key.`)
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw new Error('Invalid SHA-256 digest.')
  return `${MEDIA_SITE}/listings/${input.slug}/${input.kind}/${input.sha256.slice(0, MEDIA_HASH_LENGTH)}.${IMAGE_EXTENSIONS[input.format]}`
}

export interface ParsedMediaKey {
  extension: string
  hash: string
  kind: MediaKind
  slug: string
}

export function parseMediaKey(value: string): ParsedMediaKey | null {
  const match = value.match(keyPattern)
  if (!match) return null
  return {
    extension: match[4] ?? '',
    hash: match[3] ?? '',
    kind: match[2] as MediaKind,
    slug: match[1] ?? ''
  }
}

export function isMediaKey(value: string): boolean {
  return keyPattern.test(value)
}

/** The content type a key's extension stands for (keys are only ever written with their type). */
export function contentTypeForKey(key: string): string | null {
  const parsed = parseMediaKey(key)
  if (!parsed) return null
  const format = (Object.keys(IMAGE_EXTENSIONS) as HostedImageFormat[]).find(
    candidate => IMAGE_EXTENSIONS[candidate] === parsed.extension
  )
  return format ? IMAGE_CONTENT_TYPES[format] : null
}

/**
 * The public URL of a media key on the environment's media host: `https://cdn.serp.co` in
 * production, `https://cdn-staging.serp.co` on staging, and the Worker's own `/_media` path
 * locally. Any other value (a legacy URL or root-relative path not yet migrated, an admin preview
 * of a submitter's URL) is returned unchanged.
 */
export function mediaUrl(value: string, mediaBaseUrl: string): string {
  if (!isMediaKey(value)) return value
  return `${mediaBaseUrl.replace(/\/+$/u, '')}/${value}`
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A copy is backed by a plain ArrayBuffer, which `digest` requires.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

interface WithMedia {
  media?: { images?: string[]; logo?: string }
}

/** A listing DTO with its logo and image keys resolved on the media host (other fields kept). */
export function resolveListingMedia<T extends WithMedia>(listing: T, mediaBaseUrl: string): T {
  if (!listing.media) return listing
  const { images, logo } = listing.media
  return {
    ...listing,
    media: {
      ...listing.media,
      ...(images ? { images: images.map(image => mediaUrl(image, mediaBaseUrl)) } : {}),
      ...(logo ? { logo: mediaUrl(logo, mediaBaseUrl) } : {})
    }
  }
}

interface WithLinkedListings extends WithMedia {
  nextWebsite: WithMedia | null
  previousWebsite: WithMedia | null
  relatedWebsites: WithMedia[]
}

/** A listing detail with its own, its neighbors', and its related listings' media resolved. */
export function resolveListingDetailMedia<T extends WithLinkedListings>(
  detail: T,
  mediaBaseUrl: string
): T {
  return {
    ...resolveListingMedia(detail, mediaBaseUrl),
    nextWebsite: detail.nextWebsite && resolveListingMedia(detail.nextWebsite, mediaBaseUrl),
    previousWebsite:
      detail.previousWebsite && resolveListingMedia(detail.previousWebsite, mediaBaseUrl),
    relatedWebsites: detail.relatedWebsites.map(related =>
      resolveListingMedia(related, mediaBaseUrl)
    )
  }
}

/**
 * The media host this environment's pages use: an https origin (no path) on staging and in
 * production, or the local Worker's own `/_media` path. Anything else fails closed.
 */
export function validateMediaBaseUrl(value: string | undefined, runtime: string): string {
  const base = value?.trim() ?? ''
  if (runtime === 'local') {
    if (base === LOCAL_MEDIA_PATH) return base
    throw new Error(`MEDIA_BASE_URL must be ${LOCAL_MEDIA_PATH} locally.`)
  }
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(
      'MEDIA_BASE_URL must be the media host origin, for example https://cdn.serp.co.'
    )
  }
  if (url.protocol !== 'https:' || url.origin !== base) {
    throw new Error('MEDIA_BASE_URL must be an https origin without a path or trailing slash.')
  }
  return base
}
