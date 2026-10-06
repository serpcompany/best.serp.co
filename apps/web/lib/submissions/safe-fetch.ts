import { validatePublicHttpUrl } from '@serpdirectory/data-ops/public-url'
import { fetchMimeType } from './html-encoding'

/**
 * The one way submission code fetches a submitter's URLs (badge verification, URL prefill, and
 * logo checks): every hop, including each redirect, must be a public http(s) URL
 * (`validatePublicHttpUrl`); redirects are followed by hand, at most three; each request times
 * out after 8 seconds; and a body is read up to a byte cap, never past it.
 *
 * The policy reads the URL, not DNS: a public hostname that resolves to a private address
 * passes it. Production relies on Cloudflare's egress, which never reaches private ranges,
 * for that case (docs/SUBMISSION_FLOW.md#fetching-submitters-sites).
 */

export const SUBMISSION_FETCH_USER_AGENT = 'SERPSoftwareBadgeVerifier/1.0'
export const SAFE_FETCH_TIMEOUT_MS = 8_000
export const SAFE_FETCH_MAX_REDIRECTS = 3

export type SafeFetchFailure =
  | 'fetch_timeout'
  | 'invalid_redirect'
  | 'invalid_target'
  /** The response stream failed while reading: the fetcher's fault, not the site's. */
  | 'read_failed'
  | 'response_too_large'
  | 'site_unreachable'
  | 'too_many_redirects'
  | 'unexpected_type'
  | `http_${number}`

export type SafeFetchResult =
  | { body: Uint8Array; contentType: string; headers: Headers; ok: true; url: string }
  | { code: SafeFetchFailure; ok: false }

export interface SafeFetchOptions {
  /** Accepts the response's media type (lowercase, without parameters). */
  accept: (mediaType: string) => boolean
  /** The `Accept` request header. */
  acceptHeader: string
  fetcher?: typeof fetch
  maxBytes: number
  timeoutMs?: number
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') || '0')
  if (declared > maxBytes) {
    await response.body?.cancel()
    return null
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * The response's MIME type essence as Fetch extracts it (repeated headers arrive joined with
 * commas, and the last valid type wins), or '' when there is none.
 */
export function mediaTypeOf(contentType: string | null): string {
  return fetchMimeType(contentType)?.essence ?? ''
}

export async function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const fetcher = options.fetcher ?? fetch
  let current = url
  for (let redirect = 0; redirect <= SAFE_FETCH_MAX_REDIRECTS; redirect += 1) {
    const safe = validatePublicHttpUrl(current)
    if (!safe.ok) return { code: 'invalid_target', ok: false }

    let response: Response
    try {
      response = await fetcher(safe.url, {
        headers: { Accept: options.acceptHeader, 'User-Agent': SUBMISSION_FETCH_USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS)
      })
    } catch (error) {
      return { code: isTimeout(error) ? 'fetch_timeout' : 'site_unreachable', ok: false }
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) return { code: 'invalid_redirect', ok: false }
      if (redirect === SAFE_FETCH_MAX_REDIRECTS) return { code: 'too_many_redirects', ok: false }
      try {
        current = new URL(location, safe.url).toString()
      } catch {
        return { code: 'invalid_redirect', ok: false }
      }
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { code: `http_${response.status}`, ok: false }
    }
    const contentType = mediaTypeOf(response.headers.get('content-type'))
    if (!options.accept(contentType)) {
      await response.body?.cancel()
      return { code: 'unexpected_type', ok: false }
    }
    let body: Uint8Array | null
    try {
      body = await readBounded(response, options.maxBytes)
    } catch (error) {
      return { code: isTimeout(error) ? 'fetch_timeout' : 'read_failed', ok: false }
    }
    if (!body) return { code: 'response_too_large', ok: false }
    return { body, contentType, headers: response.headers, ok: true, url: safe.url.toString() }
  }
  return { code: 'too_many_redirects', ok: false }
}
