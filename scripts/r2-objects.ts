import { createHash } from 'node:crypto'
import { MAX_MEDIA_BYTES } from '@serpdirectory/data-ops/media-keys'

/**
 * Reads and writes listing media objects through the Cloudflare R2 REST API (#95), never through
 * a media host's CDN: what a bucket holds, byte for byte, whatever an edge cache, image
 * optimization, or `Accept` negotiation would serve (#97 review B2, S3). Used by the media
 * upload (`media-upload.ts`) and the publisher's served-objects check (`d1-remote-publisher.ts`).
 * The token needs Account → Workers R2 Storage (docs/DEPLOY_RUNBOOK.md#cloudflare-api-token).
 *
 * Every call goes through one process-wide rate limiter and retries 429s and 5xx answers (#95
 * release blocker 3): the Cloudflare API allows about 1,200 requests per five minutes for the
 * whole token, and the first staging uploads spent it on verification GETs and stalled.
 */

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

/** The one Cloudflare API path this module calls: a bucket's objects (list, GET, PUT). */
function r2ObjectsUrl(accountId: string, bucket: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`
}

export function r2ObjectUrl(accountId: string, bucket: string, key: string): string {
  return `${r2ObjectsUrl(accountId, bucket)}/${key}`
}

/** Cloudflare's documented API limit is 1,200 requests per 5 minutes; stay well under it. */
export const R2_REQUESTS_PER_WINDOW = 900
export const R2_WINDOW_MS = 300_000

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * A token bucket: `requests` per `windowMs`, refilled continuously, with a burst of `burst`.
 * Callers queue in order, so concurrent workers share one budget.
 */
export class RateLimiter {
  private tokens: number
  private updated: number
  private tail: Promise<void> = Promise.resolve()
  private readonly ratePerMs: number

  constructor(
    readonly requests: number = R2_REQUESTS_PER_WINDOW,
    readonly windowMs: number = R2_WINDOW_MS,
    private readonly burst = 10,
    private readonly clock: Clock = systemClock
  ) {
    this.ratePerMs = requests / windowMs
    this.tokens = burst
    this.updated = clock.now()
  }

  /** Resolves when the caller may send one request. */
  acquire(): Promise<void> {
    const turn = this.tail.then(async () => {
      for (;;) {
        const now = this.clock.now()
        this.tokens = Math.min(this.burst, this.tokens + (now - this.updated) * this.ratePerMs)
        this.updated = now
        if (this.tokens >= 1) {
          this.tokens -= 1
          return
        }
        await this.clock.sleep(Math.ceil((1 - this.tokens) / this.ratePerMs))
      }
    })
    this.tail = turn
    return turn
  }

  /** After a 429, spend the bucket so every queued caller waits too. */
  drain(): void {
    this.tokens = Math.min(this.tokens, 0)
  }
}

export interface R2CallOptions {
  /** Attempts per request, counting the first. */
  attempts?: number
  clock?: Clock
  limiter?: RateLimiter
}

/** The limiter every R2 call in this process shares (the API limit is per token, not per call). */
export const sharedR2Limiter = new RateLimiter()

/** Milliseconds a `Retry-After` header asks for (seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * One R2 API request through the limiter, retried on 429, 5xx, and network failures: the wait is
 * the server's `Retry-After` when it sends one, else 2, 4, 8 … 64 seconds with jitter.
 */
export async function r2Request(
  fetcher: typeof fetch,
  url: string,
  init: () => RequestInit,
  options: R2CallOptions = {}
): Promise<Response> {
  const limiter = options.limiter ?? sharedR2Limiter
  const clock = options.clock ?? systemClock
  const attempts = options.attempts ?? 8
  for (let attempt = 1; ; attempt += 1) {
    await limiter.acquire()
    let response: Response | null = null
    let failure: unknown = null
    try {
      response = await fetcher(url, init())
    } catch (error) {
      failure = error
    }
    if (response && !retryable(response.status)) return response
    if (attempt >= attempts) {
      if (response) return response
      throw failure
    }
    const backoff = Math.min(64_000, 2000 * 2 ** (attempt - 1))
    const asked = response ? retryAfterMs(response.headers.get('retry-after'), clock.now()) : null
    if (response?.status === 429) limiter.drain()
    await response?.body?.cancel()
    await clock.sleep(Math.min(300_000, asked ?? backoff + Math.floor(Math.random() * 1000)))
  }
}

/**
 * The object's bytes, or null when the bucket has no object under `key`. Anything else (an API
 * error, a body over the media size cap) throws, so a caller never mistakes it for absence.
 */
export async function getR2Object(
  bucket: string,
  key: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  options: R2CallOptions = {}
): Promise<Uint8Array | null> {
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const response = await r2Request(
    fetcher,
    r2ObjectUrl(accountId, bucket, key),
    () => ({
      headers: { Authorization: `Bearer ${apiToken}` },
      method: 'GET',
      signal: AbortSignal.timeout(60_000)
    }),
    options
  )
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`r2_get_${response.status}`)
  }
  const body = new Uint8Array(await response.arrayBuffer())
  // A listing object is at most 5 MB; anything larger is not one of ours.
  if (body.byteLength > MAX_MEDIA_BYTES) throw new Error('r2_object_too_large')
  return body
}

/** What the list API says about one object: R2's ETag of a single-part upload is its MD5. */
export interface ListedObject {
  cacheControl: string | null
  contentType: string | null
  etag: string
  size: number
}

/**
 * Every object under `prefix`, 1,000 per request (#95 release blocker 3): one list call stands
 * in for a thousand verification GETs.
 */
export async function listR2Objects(
  bucket: string,
  prefix: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  options: R2CallOptions = {}
): Promise<Map<string, ListedObject>> {
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const listed = new Map<string, ListedObject>()
  let cursor: string | undefined
  for (let page = 0; page < 1000; page += 1) {
    const query = new URLSearchParams({ per_page: '1000', prefix })
    if (cursor) query.set('cursor', cursor)
    const response = await r2Request(
      fetcher,
      `${r2ObjectsUrl(accountId, bucket)}?${query}`,
      () => ({
        headers: { Authorization: `Bearer ${apiToken}` },
        method: 'GET',
        signal: AbortSignal.timeout(60_000)
      }),
      options
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`r2_list_${response.status}`)
    }
    const payload = (await response.json()) as {
      result?: Array<{
        etag?: string
        http_metadata?: { cacheControl?: string; contentType?: string }
        key?: string
        size?: number | string
      }>
      result_info?: { cursor?: string; is_truncated?: boolean | string }
      success?: boolean
    }
    if (payload.success === false || !Array.isArray(payload.result)) {
      throw new Error('r2_list_unreadable')
    }
    for (const object of payload.result) {
      if (!object.key || object.etag === undefined || object.size === undefined) {
        throw new Error('r2_list_unreadable')
      }
      listed.set(object.key, {
        cacheControl: object.http_metadata?.cacheControl ?? null,
        contentType: object.http_metadata?.contentType ?? null,
        etag: object.etag.replaceAll('"', '').toLowerCase(),
        size: Number(object.size)
      })
    }
    const info = payload.result_info
    const truncated = info?.is_truncated === true || info?.is_truncated === 'true'
    // A full page without a cursor would hide the rest, and the uploader would take the hidden
    // objects for missing ones: refuse rather than risk writing over them.
    if (!truncated && payload.result.length >= 1000) throw new Error('r2_list_pagination_unknown')
    if (!truncated) return listed
    if (!info?.cursor) throw new Error('r2_list_pagination_unknown')
    cursor = info.cursor
  }
  throw new Error('r2_list_too_long')
}

/**
 * Why a listed object is not the reviewed one, or null when it is: its size, its MD5 (R2's ETag,
 * computed by R2 from the stored bytes), its type, and the immutable cache policy all match the
 * plan, whose MD5 and SHA-256 were both taken from the same reviewed bytes.
 */
export function listedMismatch(
  object: { bytes: number; contentType: string; md5: string },
  listed: ListedObject,
  cacheControl: string
): string | null {
  if (listed.size !== object.bytes) return `bytes ${listed.size} != ${object.bytes}`
  if (listed.etag !== object.md5) return 'md5_mismatch'
  if (listed.contentType !== null && listed.contentType !== object.contentType) {
    return 'content_type_mismatch'
  }
  if (listed.cacheControl !== null && listed.cacheControl !== cacheControl) {
    return 'cache_control_mismatch'
  }
  return null
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

/**
 * A fetch failure with its cause: Node's fetch throws `TypeError: fetch failed` and keeps the
 * reason (`UND_ERR_*`, `ECONNRESET`, `ENOTFOUND`, ...) in `cause`, which a summary must show.
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  if (!(cause instanceof Error)) return error.message
  const code = (cause as Error & { code?: unknown }).code
  return `${error.message}: ${typeof code === 'string' ? `${code} ` : ''}${cause.message}`
}

/**
 * Writes one object with its type and the immutable cache policy; null on success. R2 answers
 * with the stored object's ETag (its MD5), which must be the MD5 of the bytes sent.
 */
export async function putR2Object(
  object: { bytes: number; contentType: string; key: string },
  body: Uint8Array,
  bucket: string,
  cacheControl: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  options: R2CallOptions = {}
): Promise<string | null> {
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const response = await r2Request(
    fetcher,
    r2ObjectUrl(accountId, bucket, object.key),
    () => ({
      body: new Uint8Array(body),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Cache-Control': cacheControl,
        // No Content-Length: fetch sets it from the body, and undici refuses one set by hand
        // ("invalid content-length header", thrown as `fetch failed`), which failed every object
        // of Upload Listing Media (staging) run 37471183304.
        'Content-Type': object.contentType
      },
      method: 'PUT',
      signal: AbortSignal.timeout(60_000)
    }),
    options
  )
  if (!response.ok) {
    await response.body?.cancel()
    return `r2_put_${response.status}`
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: { etag?: string }
  } | null
  const etag = payload?.result?.etag?.replaceAll('"', '').toLowerCase()
  if (etag !== undefined && etag !== md5Hex(body)) return 'r2_put_etag_mismatch'
  return null
}
