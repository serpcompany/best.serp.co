import { type HostedImageFormat, IMAGE_CONTENT_TYPES, IMAGE_EXTENSIONS } from './media-format'

/**
 * Hosted listing media (serpcompany/best.serp.co#95). Every listing image lives in the
 * environment's R2 bucket under a content-addressed, immutable key, and D1 stores that key, never
 * a URL. Pages build the URL from the environment's media host (`MEDIA_BASE_URL`).
 */

/** The prefix this site owns in the shared bucket; nothing outside it is ever written. */
export const MEDIA_SITE = 'best.serp.co'
export const MEDIA_KINDS = ['logo', 'image'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024
/** A listing's hosted image: content-addressed, so it never changes and caches for a year. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable'
/**
 * A pending image, a submission's (`best.serp.co/submissions/<id>/…`) or a revision's
 * (`best.serp.co/revisions/<id>/…`): cached five minutes, so deleting a rejected or withdrawn
 * one takes it off the media host promptly, without a zone purge (#96 review round 2, S1).
 * Approval copies it to a listing key.
 */
export const SUBMISSION_MEDIA_CACHE_CONTROL = 'public, max-age=300'
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
const submissionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const keyPattern = new RegExp(
  `^${MEDIA_SITE.replaceAll('.', '\\.')}/(listings|submissions|revisions)/([A-Za-z0-9][A-Za-z0-9._-]*)/(logo|image)/([0-9a-f]{${MEDIA_HASH_LENGTH}})\\.(png|jpg|webp|gif|avif|ico)$`,
  'u'
)

/**
 * Where an image lives: a published listing (`listings/<slug>/…`), or a submission or a
 * listing revision still in review (`submissions/<id>/…`, `revisions/<id>/…`, #96 round 4),
 * which approval copies into the listing's path. A pending image never sits under a live
 * listing's path.
 */
export type MediaOwner = { slug: string } | { submissionId: string } | { revisionId: string }

/** The scopes whose images wait for a review: short cache, deletable, copied on approval. */
export const PENDING_MEDIA_SCOPES = ['submissions', 'revisions'] as const

function digestPart(sha256: string, format: HostedImageFormat): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('Invalid SHA-256 digest.')
  return `${sha256.slice(0, MEDIA_HASH_LENGTH)}.${IMAGE_EXTENSIONS[format]}`
}

export function mediaKey(
  input: { format: HostedImageFormat; kind: MediaKind; sha256: string } & MediaOwner
): string {
  if ('slug' in input) {
    if (!slugPattern.test(input.slug)) throw new Error('Invalid listing slug for a media key.')
    return `${MEDIA_SITE}/listings/${input.slug}/${input.kind}/${digestPart(input.sha256, input.format)}`
  }
  const [scope, id] =
    'submissionId' in input
      ? (['submissions', input.submissionId] as const)
      : (['revisions', input.revisionId] as const)
  if (!submissionIdPattern.test(id)) {
    throw new Error(
      `Invalid ${scope === 'submissions' ? 'submission' : 'revision'} id for a media key.`
    )
  }
  return `${MEDIA_SITE}/${scope}/${id}/${input.kind}/${digestPart(input.sha256, input.format)}`
}

export interface ParsedMediaKey {
  extension: string
  hash: string
  kind: MediaKind
  /** The listing slug, or the submission or revision id. */
  owner: string
  scope: 'listings' | (typeof PENDING_MEDIA_SCOPES)[number]
  /** The listing slug (an empty string for a pending key). */
  slug: string
}

export function parseMediaKey(value: string): ParsedMediaKey | null {
  const match = value.match(keyPattern)
  if (!match) return null
  const scope = match[1] as ParsedMediaKey['scope']
  const owner = match[2] ?? ''
  if (scope === 'listings' ? !slugPattern.test(owner) : !submissionIdPattern.test(owner)) {
    return null
  }
  return {
    extension: match[5] ?? '',
    hash: match[4] ?? '',
    kind: match[3] as MediaKind,
    owner,
    scope,
    slug: scope === 'listings' ? owner : ''
  }
}

/** A key this site may write: a listing's, a submission's or a revision's image. */
export function isMediaKey(value: string): boolean {
  return parseMediaKey(value) !== null
}

/** A key a published listing row may hold. */
export function isListingMediaKey(value: string): boolean {
  return parseMediaKey(value)?.scope === 'listings'
}

/** A submission's or a revision's image, waiting for its review. */
export function isPendingMediaKey(value: string): boolean {
  const scope = parseMediaKey(value)?.scope
  return scope === 'submissions' || scope === 'revisions'
}

/** The listing key a pending image is copied to on approval (same bytes). */
export function listingKeyForPendingKey(key: string, slug: string): string {
  const parsed = parseMediaKey(key)
  if (!parsed || parsed.scope === 'listings') throw new Error(`${key} is not a pending media key.`)
  if (!slugPattern.test(slug)) throw new Error('Invalid listing slug for a media key.')
  return `${MEDIA_SITE}/listings/${slug}/${parsed.kind}/${parsed.hash}.${parsed.extension}`
}

/** The `Cache-Control` a key is stored with: immutable for listings, short while pending. */
export function cacheControlForKey(key: string): string {
  return isPendingMediaKey(key) ? SUBMISSION_MEDIA_CACHE_CONTROL : MEDIA_CACHE_CONTROL
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
