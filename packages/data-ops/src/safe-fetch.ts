import { validatePublicHttpUrl } from './public-url'

/**
 * The one way server code fetches a URL someone else controls (a listing's site, its icon, its
 * social image): every hop, including each redirect, must be a public http(s) URL
 * (`validatePublicHttpUrl`); redirects are followed by hand, at most three; each request times
 * out; and a body is read up to a byte cap, never past it.
 *
 * Shared by media ingestion (serpcompany/best.serp.co#95) and the legacy media migration. Submit
 * v2 (#84) carries the same function in `apps/web/lib/submissions/safe-fetch.ts`; it should
 * import this module instead once both are on `staging`.
 *
 * The policy reads the URL, not DNS: a public hostname that resolves to a private address passes
 * it. The Worker relies on Cloudflare's egress, which never reaches private ranges, for that
 * case; a script running elsewhere does not have that protection.
 */

export const SAFE_FETCH_USER_AGENT = 'SERPSoftwareBadgeVerifier/1.0'
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
  userAgent?: string
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

export function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
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
        headers: {
          Accept: options.acceptHeader,
          'User-Agent': options.userAgent ?? SAFE_FETCH_USER_AGENT
        },
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
