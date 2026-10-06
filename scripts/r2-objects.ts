import { MAX_MEDIA_BYTES } from '@serpdirectory/data-ops/media-keys'

/**
 * Reads and writes listing media objects through the Cloudflare R2 REST API (#95), never through
 * a media host's CDN: what a bucket holds, byte for byte, whatever an edge cache, image
 * optimization, or `Accept` negotiation would serve (#97 review B2, S3). Used by the media
 * upload (`media-upload.ts`) and the publisher's served-objects check (`d1-remote-publisher.ts`).
 * The token needs Account → Workers R2 Storage (docs/DEPLOY_RUNBOOK.md#cloudflare-api-token).
 */

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

export function r2ObjectUrl(accountId: string, bucket: string, key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key}`
}

/**
 * The object's bytes, or null when the bucket has no object under `key`. Anything else (an API
 * error, a body over the media size cap) throws, so a caller never mistakes it for absence.
 */
export async function getR2Object(
  bucket: string,
  key: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): Promise<Uint8Array | null> {
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const response = await fetcher(r2ObjectUrl(accountId, bucket, key), {
    headers: { Authorization: `Bearer ${apiToken}` },
    method: 'GET',
    signal: AbortSignal.timeout(60_000)
  })
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

/** Writes one object with its type and the immutable cache policy; null on success. */
export async function putR2Object(
  object: { bytes: number; contentType: string; key: string },
  body: Uint8Array,
  bucket: string,
  cacheControl: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): Promise<string | null> {
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const response = await fetcher(r2ObjectUrl(accountId, bucket, object.key), {
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
  })
  await response.body?.cancel()
  return response.ok ? null : `r2_put_${response.status}`
}
