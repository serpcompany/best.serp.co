/**
 * The network side of the listing domain check (serpcompany/best.serp.co#100). Read-only: it
 * follows a listing's website to the page a visitor lands on and records what it saw.
 *
 * Every request goes through the submission flow's `safeFetch` (each hop must be a public
 * http(s) URL, redirects are followed by hand, each request has a timeout and a byte cap). The
 * Worker relies on Cloudflare's egress to never reach a private network; this script runs on a
 * maintainer machine, so its fetcher (`guardedFetch`) adds that protection itself: ports 80 and
 * 443 only, and every address a host name resolves to is checked against the same public-URL
 * policy when the socket connects, so a public name pointing at a private address is refused
 * and nothing can change between the check and the connection.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { validatePublicHttpUrl } from '@serpdirectory/data-ops/public-url'
import { decodeHtml, fetchMimeType } from '../apps/web/lib/submissions/html-encoding'
import { parseSiteMetadata } from '../apps/web/lib/submissions/prefill'
import {
  type SafeFetchFailure,
  type SafeFetchResult,
  safeFetch
} from '../apps/web/lib/submissions/safe-fetch'
import { markupSignals, THIN_PAGE_TEXT } from './listing-domain-classifier'

/** A browser-like agent with our name in it: hijacked domains often cloak bots. */
export const DOMAIN_CHECK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 SERPCatalogCheck/1.0 (+https://best.serp.co)'
export const PAGE_MAX_BYTES = 2_000_000
export const REQUEST_TIMEOUT_MS = 12_000
/** `safeFetch` follows three redirects; a trace may continue for this many more segments. */
const MAX_SEGMENTS = 8
/** Meta-refresh or script redirects (`/lander`) followed after a page loads. */
const MAX_CLIENT_REDIRECTS = 2
const MAX_ATTEMPTS = 3

/** True when a resolved address passes the shared public-URL policy. */
export function isPublicAddress(address: string): boolean {
  return validatePublicHttpUrl(`http://${address.includes(':') ? `[${address}]` : address}/`).ok
}

class BlockedTargetError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** `dns.lookup`, refusing the whole name if any address it resolves to is not public. */
export const vettedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 4)
      return
    }
    const list = addresses as LookupAddress[]
    const blocked = list.find(entry => !isPublicAddress(entry.address))
    if (list.length === 0 || blocked) {
      callback(
        new BlockedTargetError(
          'EBLOCKED',
          `${hostname} resolves to a non-public address${blocked ? ` (${blocked.address})` : ''}.`
        ),
        '',
        4
      )
      return
    }
    if (options.all) callback(null, list)
    else callback(null, list[0]?.address ?? '', list[0]?.family ?? 4)
  })
}

/** The body, decompressed; `pipeline` passes a dropped connection on, so a read never hangs. */
function decodedBody(response: IncomingMessage): Readable {
  const decoder = (() => {
    switch ((response.headers['content-encoding'] ?? '').trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return createGunzip()
      case 'deflate':
        return createInflate()
      case 'br':
        return createBrotliDecompress()
      default:
        return null
    }
  })()
  if (!decoder) return response
  pipeline(response, decoder, () => undefined)
  return decoder
}

/**
 * A `fetch` for `safeFetch` on Node: GET only, ports 80 and 443 only, `vettedLookup` on every
 * connection, no connection reuse, and the body decompressed. Errors carry Node's `code`.
 */
export const guardedFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolveResponse, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.port !== '' || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      reject(new BlockedTargetError('EPORT', `Refusing ${url.origin}: ports 80 and 443 only.`))
      return
    }
    // Node skips the lookup hook for an IP literal, so check it here.
    const literal = url.hostname.replace(/^\[|\]$/gu, '')
    if (isIP(literal) !== 0 && !isPublicAddress(literal)) {
      reject(new BlockedTargetError('EBLOCKED', `Refusing ${url.origin}: not a public address.`))
      return
    }
    const headers: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9'
    }
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        headers,
        lookup: vettedLookup,
        method: 'GET',
        signal: init?.signal ?? undefined
      },
      response => {
        const status = response.statusCode ?? 0
        const responseHeaders = new Headers()
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index] ?? ''
          if (/^content-(?:encoding|length)$/iu.test(name)) continue
          try {
            responseHeaders.append(name, response.rawHeaders[index + 1] ?? '')
          } catch {
            // A header value fetch would refuse; nothing the check reads.
          }
        }
        const empty = status === 204 || status === 205 || status === 304
        if (empty) response.resume()
        try {
          resolveResponse(
            new Response(
              empty ? null : (Readable.toWeb(decodedBody(response)) as ReadableStream<Uint8Array>),
              { headers: responseHeaders, status }
            )
          )
        } catch (error) {
          response.destroy()
          reject(error)
        }
      }
    )
    // An idle socket (a server that stops sending mid-body) is destroyed, which ends the read.
    request.setTimeout(REQUEST_TIMEOUT_MS, () =>
      request.destroy(new BlockedTargetError('ETIMEDOUT', `${url.origin} stopped responding.`))
    )
    request.on('error', reject)
    request.end()
  })

/** Longest one `safeFetch` (up to four requests and a body) may take before it counts as a timeout. */
const SEGMENT_DEADLINE_MS = 4 * REQUEST_TIMEOUT_MS + 15_000

/** Resolves a hung fetch as a timeout, so one stalled server never stops a scan. */
function withDeadline(work: Promise<SafeFetchResult>): Promise<SafeFetchResult> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<SafeFetchResult>(resolveDeadline => {
    timer = setTimeout(
      () => resolveDeadline({ code: 'fetch_timeout', ok: false }),
      SEGMENT_DEADLINE_MS
    )
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** One request of a trace: where it went and what came back. */
export interface Hop {
  url: string
  status?: number
  location?: string
  /** A network error code (`ENOTFOUND`, `EBLOCKED`, `CERT_HAS_EXPIRED`, ...). */
  error?: string
  /** True for a meta-refresh or script redirect found in a page. */
  client?: true
  /** The `server` header, and whether a bot challenge answered (`cf-mitigated`). */
  server?: string
  challenge?: true
}

export interface PageSignals {
  title: string | null
  description: string | null
  siteName: string | null
  headings: string[]
  /** Visible text, collapsed, at most 10,000 characters. */
  text: string
  /** The first 48 KB of markup of a thin page, for parking-provider fingerprints; else ''. */
  html: string
  /** Gambling markers in the whole markup (ads), and how often it says "slot". */
  markup?: { markers: string[]; slots: number }
}

export interface SiteObservation {
  website: string
  hops: Hop[]
  /** The last URL requested. */
  finalUrl: string
  /** `page` when an HTML page was read; otherwise why not. */
  result: 'page' | SafeFetchFailure
  /** The last HTTP status, or null when no response arrived. */
  status: number | null
  error: string | null
  attempts: number
  page: PageSignals | null
  /** Markup of pages that redirected on the client (a parking `/lander` stub, say). */
  stubs: string[]
}

const TEXT_LIMIT = 10_000
const HTML_LIMIT = 48_000

function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
}

function decodeEntityText(value: string): string {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
      if (entity[0] !== '#') {
        const named: Record<string, string> = { amp: '&', gt: '>', lt: '<', nbsp: ' ', quot: '"' }
        return named[entity.toLowerCase()] ?? match
      }
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    })
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The signals the classifier reads from a page (`listing-domain-classifier.ts`). */
export function pageSignals(html: string, url: string): PageSignals {
  const metadata = parseSiteMetadata(html, url)
  const bodyStart = html.search(/<body[\s>]/iu)
  const body = bodyStart === -1 ? html : html.slice(bodyStart)
  const headings = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/giu)]
    .map(match => decodeEntityText(stripTags(match[1] ?? '')).slice(0, 200))
    .filter(Boolean)
    .slice(0, 3)
  const text = decodeEntityText(stripTags(body))
  return {
    title: metadata.title,
    description: metadata.description?.value ?? null,
    siteName: metadata.ogSiteName,
    headings,
    text: text.slice(0, TEXT_LIMIT),
    html: text.length < THIN_PAGE_TEXT ? html.slice(0, HTML_LIMIT) : '',
    markup: markupSignals(html)
  }
}

/**
 * Where a page sends the browser by itself: a `<meta http-equiv="refresh">`, or, on a near-empty
 * page, a script that only sets `location` (parking landers do this). Null otherwise.
 */
export function clientRedirect(html: string, pageUrl: string): string | null {
  const refresh = [...html.matchAll(/<meta\b[^>]*>/giu)]
    .map(match => match[0])
    .find(tag => /http-equiv\s*=\s*["']?refresh/iu.test(tag))
  let target = refresh?.match(/content\s*=\s*["'][^"']*?url\s*=\s*['"]?([^"'>\s;]+)/iu)?.[1]
  if (!target && html.length < 8_000 && decodeEntityText(stripTags(html)).length < 300) {
    target =
      html.match(
        /(?:window\.|document\.|self\.|top\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/u
      )?.[1] ?? html.match(/location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/u)?.[1]
  }
  if (!target) return null
  try {
    const next = new URL(decodeEntityText(target), pageUrl)
    return next.protocol === 'http:' || next.protocol === 'https:' ? next.toString() : null
  } catch {
    return null
  }
}

/** A failure worth another attempt: a timeout, a dropped connection, a 429, or a 5xx. */
export function isTransient(result: SafeFetchFailure, error: string | null): boolean {
  if (result === 'fetch_timeout' || result === 'read_failed') return true
  if (result === 'site_unreachable')
    return !error || /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR)/u.test(error)
  const status = /^http_(\d+)$/u.exec(result)?.[1]
  return status === '429' || (status !== undefined && Number(status) >= 500)
}

export interface TraceOptions {
  fetcher?: typeof fetch
  /** Waits between attempts; tests pass a no-op. */
  sleep?: (milliseconds: number) => Promise<void>
}

const wait = (milliseconds: number) =>
  new Promise<void>(resolveWait => setTimeout(resolveWait, milliseconds))

/**
 * Follows `website` to the page a visitor reaches and returns what every hop answered. Retries
 * transient failures twice. Never sends anything but GET requests without credentials.
 */
export async function traceWebsite(
  website: string,
  options: TraceOptions = {}
): Promise<SiteObservation> {
  const fetcher = options.fetcher ?? guardedFetch
  const sleep = options.sleep ?? wait
  let observation: SiteObservation | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const hops: Hop[] = []
    const stubs: string[] = []
    let retryAfterSeconds: string | null = null
    // Records every request safeFetch makes, so the trace keeps redirects and failed hops.
    const recorder: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      // safeFetch sends the submission flow's agent; this check announces itself as a browser.
      const headers = new Headers(init?.headers)
      headers.set('User-Agent', DOMAIN_CHECK_USER_AGENT)
      try {
        const response = await fetcher(input, { ...init, headers })
        const hop: Hop = { url, status: response.status }
        const location = response.headers.get('location')
        if (location) hop.location = location
        const server = response.headers.get('server')
        if (server) hop.server = server.slice(0, 40)
        if (response.headers.get('cf-mitigated')) hop.challenge = true
        if (response.status === 429) retryAfterSeconds = response.headers.get('retry-after')
        hops.push(hop)
        return response
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : typeof error === 'object' && error !== null && 'cause' in error
              ? String((error.cause as { code?: string } | undefined)?.code ?? 'error')
              : 'error'
        hops.push({ url, error: code })
        throw error
      }
    }
    let current = website
    let segments = 0
    let clientRedirects = 0
    let result: SiteObservation['result'] = 'site_unreachable'
    let page: PageSignals | null = null
    while (true) {
      const fetched = await withDeadline(
        safeFetch(current, {
          accept: type => type === 'text/html' || type === 'application/xhtml+xml',
          acceptHeader: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          fetcher: recorder,
          maxBytes: PAGE_MAX_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS
        })
      )
      const last = hops.at(-1)
      if (!fetched.ok) {
        if (fetched.code === 'too_many_redirects' && segments < MAX_SEGMENTS && last?.location) {
          segments += 1
          current = new URL(last.location, last.url).toString()
          continue
        }
        result = fetched.code
        break
      }
      const decoded = decodeHtml(
        fetched.body,
        fetchMimeType(fetched.headers.get('content-type'))?.charset ?? null
      )
      const html = decoded?.html ?? new TextDecoder().decode(fetched.body)
      const next = clientRedirect(html, fetched.url)
      if (next && next !== fetched.url && clientRedirects < MAX_CLIENT_REDIRECTS) {
        clientRedirects += 1
        stubs.push(html.slice(0, 4_000))
        hops.push({ url: fetched.url, status: 200, location: next, client: true })
        current = next
        continue
      }
      result = 'page'
      page = pageSignals(html, fetched.url)
      break
    }
    const last = hops.at(-1)
    observation = {
      website,
      hops,
      finalUrl: last?.client ? (last.location ?? current) : (last?.url ?? current),
      result,
      status: last?.status ?? null,
      error: last?.error ?? null,
      attempts: attempt,
      page,
      stubs
    }
    if (result === 'page' || !isTransient(result, observation.error)) return observation
    // A 429 asks for a pause: honour its Retry-After (at most 30 seconds).
    const retryAfter = Number(retryAfterSeconds ?? '')
    if (attempt < MAX_ATTEMPTS)
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 30) * 1_000
          : 1_500 * attempt * (observation.status === 429 ? 4 : 1)
      )
  }
  return observation as SiteObservation
}
