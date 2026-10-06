import { type HostedImageFormat, IMAGE_CONTENT_TYPES, sniffImage } from './media-format'
import {
  type HostedMedia,
  isMediaKey,
  MAX_MEDIA_BYTES,
  MEDIA_CACHE_CONTROL,
  type MediaKind,
  mediaKey,
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

/** The subset of Workers' `R2Bucket` that ingestion writes through. */
export interface MediaBucket {
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
 * listing keys: a key outside `best.serp.co/listings/` is refused before it reaches R2.
 */
export function scopedMediaBucket(bucket: MediaBucket): MediaBucket {
  return {
    put(key, value, options) {
      if (!isMediaKey(key)) return Promise.reject(new Error(`Refusing to write ${key}.`))
      return bucket.put(key, value, options)
    }
  }
}

export type MediaFetchFailure =
  | SafeFetchFailure
  | 'image_too_small'
  | 'store_failed'
  | 'svg'
  | 'unknown_format'
  | 'unreadable_dimensions'

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
    userAgent: options.userAgent
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

/** The hosted record for fetched bytes; the key depends only on the listing, kind, and bytes. */
export function hostedMediaFor(
  image: Omit<FetchedImage, 'ok' | 'url'>,
  target: { kind: MediaKind; slug: string; sourceUrl: string }
): HostedMedia {
  return {
    bytes: image.body.byteLength,
    contentType: image.contentType,
    height: image.height,
    key: mediaKey({
      format: image.format,
      kind: target.kind,
      sha256: image.sha256,
      slug: target.slug
    }),
    sha256: image.sha256,
    sourceUrl: target.sourceUrl,
    width: image.width
  }
}

export async function storeHostedMedia(
  bucket: MediaBucket,
  media: HostedMedia,
  body: Uint8Array
): Promise<boolean> {
  try {
    await bucket.put(media.key, body, {
      customMetadata: { sha256: media.sha256, source: media.sourceUrl.slice(0, 1024) },
      httpMetadata: { cacheControl: MEDIA_CACHE_CONTROL, contentType: media.contentType },
      sha256: media.sha256
    })
    return true
  } catch {
    return false
  }
}

export interface IngestImageInput extends FetchImageOptions {
  bucket: MediaBucket
  kind: MediaKind
  slug: string
  sourceUrl: string
}

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
