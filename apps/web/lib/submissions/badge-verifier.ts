import { validatePublicHttpUrl } from '@serpdirectory/data-ops/public-url'
import { BADGE_VERIFIER_USER_AGENT } from '@serpdirectory/web-core/forms/submission-contract'

const MAX_HTML_BYTES = 1_000_000
const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 8_000

type ScanResult =
  | { ok: true }
  | { ok: false; code: 'badge_missing' | 'nofollow' | 'wrong_destination' }

export type BadgeVerificationResult =
  | ScanResult
  | {
      ok: false
      code:
        | 'fetch_timeout'
        | 'invalid_target'
        | 'invalid_redirect'
        | 'not_html'
        | 'response_too_large'
        | 'site_unreachable'
        | 'too_many_redirects'
        | 'verification_service_error'
        | `http_${number}`
    }

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function canonical(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function scanFeaturedBadge(
  html: string,
  expected: { badgeUrls: readonly string[]; listingUrl: string }
): ScanResult {
  const expectedBadges = new Set(expected.badgeUrls.map(canonical))
  const expectedListing = canonical(expected.listingUrl)
  let sawBadge = false
  let sawWrongDestination = false

  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const anchor = match[0]
    const inner = match[1]
    const href = attribute(anchor, 'href')
    for (const image of inner.matchAll(/<img\b[^>]*>/gi)) {
      const src = attribute(image[0], 'src')
      if (!src) continue
      let isExpected = false
      try {
        isExpected = expectedBadges.has(canonical(src))
      } catch {
        continue
      }
      if (!isExpected) continue
      sawBadge = true
      if (!href) {
        sawWrongDestination = true
        continue
      }
      try {
        if (canonical(href) !== expectedListing) {
          sawWrongDestination = true
          continue
        }
      } catch {
        sawWrongDestination = true
        continue
      }
      const rel = (attribute(anchor, 'rel') || '').toLowerCase().split(/\s+/)
      if (rel.includes('nofollow')) return { ok: false, code: 'nofollow' }
      return { ok: true }
    }
  }
  if (sawBadge || sawWrongDestination) return { ok: false, code: 'wrong_destination' }
  return { ok: false, code: 'badge_missing' }
}

async function readBoundedHtml(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || '0')
  if (declaredLength > MAX_HTML_BYTES) throw new Error('response_too_large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let html = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_HTML_BYTES) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    html += decoder.decode(value, { stream: true })
  }
  return html + decoder.decode()
}

export async function verifyFeaturedBadge(
  website: string,
  expected: { badgeUrls: readonly string[]; listingUrl: string },
  fetcher: typeof fetch = fetch
): Promise<BadgeVerificationResult> {
  let current = website
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const safe = validatePublicHttpUrl(current)
    if (!safe.ok) return { ok: false, code: 'invalid_target' }

    let response: Response
    try {
      response = await fetcher(safe.url, {
        headers: { 'User-Agent': BADGE_VERIFIER_USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'TimeoutError'
      ) {
        return { ok: false, code: 'fetch_timeout' }
      }
      return { ok: false, code: 'site_unreachable' }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { ok: false, code: 'invalid_redirect' }
      if (redirect === MAX_REDIRECTS) return { ok: false, code: 'too_many_redirects' }
      try {
        current = new URL(location, safe.url).toString()
      } catch {
        return { ok: false, code: 'invalid_redirect' }
      }
      continue
    }
    if (!response.ok) return { ok: false, code: `http_${response.status}` }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().includes('text/html')) return { ok: false, code: 'not_html' }
    try {
      return scanFeaturedBadge(await readBoundedHtml(response), expected)
    } catch (error) {
      if (error instanceof Error && error.message === 'response_too_large') {
        return { ok: false, code: 'response_too_large' }
      }
      return { ok: false, code: 'verification_service_error' }
    }
  }
  return { ok: false, code: 'verification_service_error' }
}
