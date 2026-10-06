import {
  type HostedImageFormat,
  IMAGE_CONTENT_TYPES,
  type ImageSniffFailure,
  sniffImage
} from './media-format'
import {
  cacheControlForKey,
  type HostedMedia,
  isMediaKey,
  MAX_MEDIA_BYTES,
  type MediaKind,
  type MediaOwner,
  mediaKey,
  parseMediaKey,
  sha256Hex
} from './media-keys'
import { type SafeFetchFailure, safeFetch } from './safe-fetch'

/**
 * Copies an image someone else hosts into the environment's media bucket
 * (serpcompany/best.serp.co#95): fetch it through the public-URL policy, recognize it by its
 * bytes, refuse SVG and anything over the size cap, read its dimensions, and store it under its
 * content-addressed key with an immutable cache policy. The caller records the result in D1; a
 * failure leaves the listing on the fallback tile, never on the source URL.
 */

/** The subset of Workers' `R2Bucket` that ingestion reads and writes through. */
export interface MediaBucket {
  delete?(key: string): Promise<unknown>
  get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(
    key: string,
    value: Uint8Array,
    options: {
      customMetadata?: Record<string, string>
      httpMetadata: { cacheControl: string; contentType: string }
      sha256?: string
    }
  ): Promise<unknown>
}

/**
 * The production bucket is shared with serp.co (`cdn`), so every write is held to this site's
 * keys (`best.serp.co/listings/…` and `best.serp.co/submissions/…`): any other key is refused
 * before it reaches R2. `storeHostedMedia` checks the same, so an unwrapped bucket is safe too.
 * The runtime deletes only a submission's own images (`best.serp.co/submissions/…`); a listing's
 * hosted image is never deleted by the Worker.
 */
export function scopedMediaBucket(bucket: MediaBucket): MediaBucket {
  return {
    delete(key) {
      if (parseMediaKey(key)?.scope !== 'submissions' || !bucket.delete) {
        return Promise.reject(new Error(`Refusing to delete ${key}.`))
      }
      return bucket.delete(key)
    },
    get: bucket.get?.bind(bucket),
    put(key, value, options) {
      if (!isMediaKey(key)) return Promise.reject(new Error(`Refusing to write ${key}.`))
      return bucket.put(key, value, options)
    }
  }
}

export type MediaFetchFailure =
  | SafeFetchFailure
  | ImageSniffFailure
  | 'copy_mismatch'
  /** The reviewed submission object is gone, and the source no longer serves its bytes. */
  | 'reviewed_copy_missing'
  /** The source now serves other bytes than the reviewed ones (never published). */
  | 'reviewed_copy_changed'
  | 'image_too_small'
  | 'store_failed'

export type FetchedImage = {
  body: Uint8Array
  contentType: string
  format: HostedImageFormat
  height: number
  ok: true
  sha256: string
  /** The URL the bytes came from, after redirects. */
  url: string
  width: number
}

export type MediaFailure = { code: MediaFetchFailure; ok: false; retryable: boolean }

export interface FetchImageOptions {
  fetcher?: typeof fetch
  maxBytes?: number
  /** Refuse an image whose shorter side is below this (a logo may need a usable size). */
  minPixels?: number
  timeoutMs?: number
  userAgent?: string
  /** Refuse ports other than 80 and 443 (the default); a local Worker's fixtures use others. */
  webPortsOnly?: boolean
}

/** Failures worth retrying later: the source may answer next time. */
export function isRetryableMediaFailure(code: MediaFetchFailure): boolean {
  if (
    code === 'fetch_timeout' ||
    code === 'read_failed' ||
    code === 'site_unreachable' ||
    code === 'store_failed'
  ) {
    return true
  }
  const status = code.startsWith('http_') ? Number(code.slice('http_'.length)) : 0
  return status === 408 || status === 429 || status >= 500
}

function failure(code: MediaFetchFailure): MediaFailure {
  return { code, ok: false, retryable: isRetryableMediaFailure(code) }
}

export async function fetchImage(
  sourceUrl: string,
  options: FetchImageOptions = {}
): Promise<FetchedImage | MediaFailure> {
  const result = await safeFetch(sourceUrl, {
    // The bytes decide the format; servers often label images loosely, so only a page is refused.
    accept: type => type !== 'text/html' && type !== 'application/xhtml+xml',
    acceptHeader: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
    fetcher: options.fetcher,
    maxBytes: options.maxBytes ?? MAX_MEDIA_BYTES,
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent,
    webPortsOnly: options.webPortsOnly ?? true
  })
  if (!result.ok) return failure(result.code)
  const sniffed = sniffImage(result.body)
  if (!sniffed.ok) return failure(sniffed.reason)
  if (options.minPixels && Math.min(sniffed.width, sniffed.height) < options.minPixels) {
    return failure('image_too_small')
  }
  return {
    body: result.body,
    contentType: IMAGE_CONTENT_TYPES[sniffed.format],
    format: sniffed.format,
    height: sniffed.height,
    ok: true,
    sha256: await sha256Hex(result.body),
    url: result.url,
    width: sniffed.width
  }
}

/** The hosted record for fetched bytes; the key depends only on its owner, kind, and bytes. */
export function hostedMediaFor(
  image: Omit<FetchedImage, 'ok' | 'url'>,
  target: { kind: MediaKind; sourceUrl: string } & MediaOwner
): HostedMedia {
  const owner: MediaOwner =
    'slug' in target ? { slug: target.slug } : { submissionId: target.submissionId }
  return {
    bytes: image.body.byteLength,
    contentType: image.contentType,
    height: image.height,
    key: mediaKey({ format: image.format, kind: target.kind, sha256: image.sha256, ...owner }),
    sha256: image.sha256,
    sourceUrl: target.sourceUrl,
    width: image.width
  }
}

/**
 * The only write to the media bucket. It refuses any key outside this site's listing and
 * submission keys, so no caller can write elsewhere in the shared `cdn` bucket.
 */
export async function storeHostedMedia(
  bucket: MediaBucket,
  media: HostedMedia,
  body: Uint8Array
): Promise<boolean> {
  if (!isMediaKey(media.key)) return false
  try {
    await bucket.put(media.key, body, {
      customMetadata: { sha256: media.sha256, source: media.sourceUrl.slice(0, 1024) },
      httpMetadata: { cacheControl: cacheControlForKey(media.key), contentType: media.contentType },
      sha256: media.sha256
    })
    return true
  } catch {
    return false
  }
}

export type IngestImageInput = FetchImageOptions & {
  bucket: MediaBucket
  kind: MediaKind
  sourceUrl: string
} & MediaOwner

/** Fetches, validates, and stores one image; the result is what D1 records. */
export async function ingestImage(
  input: IngestImageInput
): Promise<{ media: HostedMedia; ok: true } | MediaFailure> {
  const image = await fetchImage(input.sourceUrl, input)
  if (!image.ok) return image
  const media = hostedMediaFor(image, input)
  if (!(await storeHostedMedia(input.bucket, media, image.body))) return failure('store_failed')
  return { media, ok: true }
}

/**
 * Copies a hosted image within the bucket (a submission's image into its approved listing's
 * path), checking the stored bytes against the recorded digest and format first.
 */
export async function copyHostedMedia(
  bucket: MediaBucket,
  fromKey: string,
  media: HostedMedia
): Promise<{ media: HostedMedia; ok: true } | MediaFailure> {
  if (!bucket.get) return failure('store_failed')
  let object: Awaited<ReturnType<NonNullable<MediaBucket['get']>>>
  try {
    object = await bucket.get(fromKey)
  } catch {
    // R2 unavailable: worth retrying the copy later.
    return failure('store_failed')
  }
  if (!object) return failure('reviewed_copy_missing')
  const body = new Uint8Array(await object.arrayBuffer())
  const sniffed = sniffImage(body)
  if (!sniffed.ok) return failure(sniffed.reason)
  if (
    (await sha256Hex(body)) !== media.sha256 ||
    IMAGE_CONTENT_TYPES[sniffed.format] !== media.contentType ||
    body.byteLength !== media.bytes
  ) {
    return failure('copy_mismatch')
  }
  if (!(await storeHostedMedia(bucket, media, body))) return failure('store_failed')
  return { media, ok: true }
}
