/**
 * Edge cache for anonymous public responses (HTML documents, RSC payloads, feeds, and
 * sitemaps), applied by the Worker entry (`apps/web/worker.ts`) in front of OpenNext.
 *
 * Public content only changes when the catalog epoch changes (a publication, an approval,
 * or a scheduled listing becoming due; see `@/db/catalog-epoch`), and
 * rendered markup only changes with a deployment. Both are part of every cache key, so a
 * hit never needs D1 or the Next.js server and nothing has to be purged: new keys simply
 * stop matching old entries, which then expire.
 *
 * This module has no Next.js or `server-only` imports so it can run before the Next.js
 * server is loaded, and every dependency (cache, epoch reader, clock) is injected.
 */
import { hasAuthCookie } from '../auth/cookies'

/** How long a stored response may be reused under the same epoch and deployment. */
export const HTML_CACHE_TTL_SECONDS = 24 * 60 * 60
/** An isolate reuses its last epoch this long before revalidating it in the background. */
export const EPOCH_FRESH_MS = 30_000
/** Past this age a request waits for a fresh epoch instead of using the last one. */
export const EPOCH_MAX_STALE_MS = 5 * 60_000

export const EDGE_CACHE_HEADER = 'x-edge-cache'
const ORIGINAL_CACHE_CONTROL_HEADER = 'x-edge-cache-origin-cache-control'
const CACHE_KEY_ORIGIN = 'https://html-cache.invalid'

/** First path segments that are personalized, private, mutable, or free-form: never cached. */
const BYPASS_PATH_SEGMENTS = new Set([
  '_next',
  'account',
  'admin',
  'api',
  'cdn-cgi',
  'login',
  'search'
])

/** Next.js preview cookies; Better Auth cookies are matched by `hasAuthCookie`. */
const PREVIEW_COOKIE_PATTERN = /__prerender_bypass|__next_preview_data/u

/** Request headers that select a different React Server Components payload. */
const RSC_VARIANT_HEADERS = [
  'rsc',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-router-state-tree',
  'next-url'
] as const

/**
 * The only client request headers a cacheable request is rendered with. Every other header a
 * client sends is dropped before OpenNext sees it, so no request-controlled value (an
 * `x-nonce`, a forwarded host, a framework-internal `x-middleware-*` or `x-opennext-*`
 * header, a cookie) can reach a response that the cache then serves to everyone. The RSC
 * router headers are part of the cache key; `accept` and `user-agent` only choose between
 * framework behaviors (for example, blocking metadata for crawlers) and are never copied into
 * a page. `host` is not copied either: `renderRequestFor` sets it from the request URL.
 */
const RENDER_REQUEST_HEADERS = ['accept', 'user-agent', ...RSC_VARIANT_HEADERS] as const

// 410: an unpublished listing's gone page (#64, `lib/routing/gone-listing.ts`).
const CACHEABLE_STATUSES = new Set([200, 301, 308, 404, 410])

export type EdgeCacheState = 'BYPASS' | 'HIT' | 'MISS'

export interface EdgeCacheContext {
  waitUntil(promise: Promise<unknown>): void
}

/**
 * The catalog epoch a response is keyed on (`token`), and the D1 bookmark of the read that
 * returned it (#382), or null when unknown. A render of a miss gets both: its catalog reads start
 * at the bookmark, so nothing it stores under the epoch is older than the epoch. The bookmark is
 * never part of a key: every D1 write moves it.
 */
export interface EpochRead {
  bookmark: string | null
  token: string
}

export interface EdgeCacheOptions {
  /** Worker-local Cache API namespace for stored responses. */
  cache: Cache
  /** Identifies the deployed build (Worker version); markup and asset URLs change with it. */
  deploymentId: string
  /** Current catalog epoch, or null when it cannot be read (the cache is bypassed). */
  epoch: (context: EdgeCacheContext) => Promise<EpochRead | null>
  observe?: (event: EdgeCacheEvent) => void
}

export interface EdgeCacheEvent {
  event: 'edge_cache'
  state: EdgeCacheState | 'store-error' | 'epoch-error'
  status?: number
}

export function isCacheableRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (request.headers.has('authorization')) return false
  // A signed-in visitor (any Better Auth cookie) is never served from, or stored in, the cache.
  const cookie = request.headers.get('cookie')
  if (hasAuthCookie(cookie) || (cookie && PREVIEW_COOKIE_PATTERN.test(cookie))) return false
  const firstSegment = (new URL(request.url).pathname.split('/')[1] ?? '').toLowerCase()
  return !BYPASS_PATH_SEGMENTS.has(firstSegment)
}

/**
 * The request a cacheable request is rendered from: same URL, method, and signal, only the
 * allowlisted headers (`RENDER_REQUEST_HEADERS`), and a `Host` equal to the normalized URL host
 * the cache key uses (lowercase, no default port). The page (for example, whether the root
 * layout loads analytics on best.serp.co) then always matches the key it is stored under, even
 * if the client spelled the host differently (`BEST.SERP.CO:443`).
 */
export function renderRequestFor(request: Request): Request {
  const headers = new Headers()
  for (const name of RENDER_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('host', new URL(request.url).host)
  return new Request(request, { headers })
}

export function isCacheableResponse(response: Response): boolean {
  return CACHEABLE_STATUSES.has(response.status) && !response.headers.has('set-cookie')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The cache key covers everything the response can vary on: deployment, catalog epoch,
 * host (for example the `noindex` header on workers.dev), path and query, and for RSC
 * requests the router headers Next.js lists in `Vary`.
 */
export async function cacheKeyFor(
  request: Request,
  deploymentId: string,
  epoch: string
): Promise<Request> {
  const url = new URL(request.url)
  const variantSource = RSC_VARIANT_HEADERS.map(
    name => `${name}:${request.headers.get(name) ?? ''}`
  ).join('\n')
  const variant = request.headers.has('rsc')
    ? `rsc-${(await sha256Hex(variantSource)).slice(0, 32)}`
    : 'document'
  const key = [
    CACHE_KEY_ORIGIN,
    encodeURIComponent(deploymentId),
    encodeURIComponent(epoch),
    variant,
    encodeURIComponent(url.host)
  ].join('/')
  return new Request(`${key}${url.pathname}${url.search}`, { method: 'GET' })
}

function withState(response: Response, state: EdgeCacheState): Response {
  const headers = new Headers(response.headers)
  headers.set(EDGE_CACHE_HEADER, state)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  })
}

/** The stored copy is publicly cacheable for the TTL; the visitor-facing header is kept. */
function storedCopy(response: Response): Response {
  const headers = new Headers(response.headers)
  const original = headers.get('cache-control')
  if (original) headers.set(ORIGINAL_CACHE_CONTROL_HEADER, original)
  headers.set('cache-control', `public, max-age=${HTML_CACHE_TTL_SECONDS}`)
  headers.delete(EDGE_CACHE_HEADER)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  })
}

function servedCopy(cached: Response, method: string): Response {
  const headers = new Headers(cached.headers)
  const original = headers.get(ORIGINAL_CACHE_CONTROL_HEADER)
  headers.delete(ORIGINAL_CACHE_CONTROL_HEADER)
  if (original) headers.set('cache-control', original)
  else headers.delete('cache-control')
  headers.delete('age')
  headers.delete('cf-cache-status')
  headers.set(EDGE_CACHE_HEADER, 'HIT')
  return new Response(method === 'HEAD' ? null : cached.body, {
    headers,
    status: cached.status,
    statusText: cached.statusText
  })
}

/**
 * Serves `request` from the edge cache when possible, otherwise from `render`, storing
 * cacheable responses in the background. A cacheable request is rendered from
 * `renderRequestFor(request)`, so what is stored depends only on the cache key; a bypassed
 * request is rendered as sent. Only the render of a miss gets the epoch its key names (#382); a
 * bypassed render (signed in, private paths, no epoch) gets none.
 */
export async function withEdgeCache(
  request: Request,
  context: EdgeCacheContext,
  options: EdgeCacheOptions,
  render: (request: Request, epoch?: EpochRead) => Promise<Response>
): Promise<Response> {
  const observe = options.observe ?? (() => {})
  if (!isCacheableRequest(request)) {
    observe({ event: 'edge_cache', state: 'BYPASS' })
    return withState(await render(request), 'BYPASS')
  }
  const renderRequest = renderRequestFor(request)

  let epoch: EpochRead | null = null
  try {
    epoch = await options.epoch(context)
  } catch {
    observe({ event: 'edge_cache', state: 'epoch-error' })
  }
  if (!epoch) {
    observe({ event: 'edge_cache', state: 'BYPASS' })
    return withState(await render(renderRequest), 'BYPASS')
  }

  const key = await cacheKeyFor(request, options.deploymentId, epoch.token)
  const cached = await options.cache.match(key).catch(() => undefined)
  if (cached) {
    observe({ event: 'edge_cache', state: 'HIT', status: cached.status })
    return servedCopy(cached, request.method)
  }

  const response = await render(renderRequest, epoch)
  observe({ event: 'edge_cache', state: 'MISS', status: response.status })
  if (request.method !== 'GET' || !isCacheableResponse(response)) {
    return withState(response, 'MISS')
  }
  const stored = storedCopy(response.clone())
  context.waitUntil(
    options.cache.put(key, stored).catch(() => {
      observe({ event: 'edge_cache', state: 'store-error', status: response.status })
    })
  )
  return withState(response, 'MISS')
}

interface MemoEntry {
  fetchedAt: number
  read: EpochRead
}

/**
 * Per-isolate memo of the catalog epoch (with its bookmark, #382) with stale-while-revalidate:
 * requests inside `freshMs` reuse it, requests inside `maxStaleMs` reuse it while one background
 * refresh runs, and older values are refreshed before answering. Concurrent refreshes share one
 * load, so a busy isolate reads the epoch at most once per `freshMs`.
 */
export class EpochMemo {
  private inflight: Promise<EpochRead> | undefined
  private value: MemoEntry | undefined

  constructor(
    private readonly load: () => Promise<EpochRead>,
    private readonly now: () => number = Date.now,
    private readonly freshMs = EPOCH_FRESH_MS,
    private readonly maxStaleMs = EPOCH_MAX_STALE_MS
  ) {}

  async current(context: EdgeCacheContext): Promise<EpochRead> {
    const value = this.value
    const age = value ? this.now() - value.fetchedAt : Number.POSITIVE_INFINITY
    if (value && age < this.freshMs) return value.read
    if (value && age < this.maxStaleMs) {
      context.waitUntil(this.refresh().catch(() => undefined))
      return value.read
    }
    return this.refresh()
  }

  private refresh(): Promise<EpochRead> {
    this.inflight ||= this.load()
      .then(read => {
        this.value = { fetchedAt: this.now(), read }
        return read
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }
}

const EPOCH_CACHE_KEY = 'https://html-cache.invalid/catalog-epoch'
/**
 * The shared entry's body is the bare token, so a Worker version from before #382 still reads
 * it; the bookmark travels beside it in this header, and an entry without one (stored by such a
 * version) reads as no bookmark, so its renders read the primary.
 */
const EPOCH_BOOKMARK_HEADER = 'x-d1-bookmark'

/**
 * Shares the epoch, and the bookmark it was read at, between the isolates of one data center
 * for `freshSeconds`, so the data center reads it from D1 at most that often.
 */
export async function loadSharedEpoch(
  cache: Cache,
  read: () => Promise<EpochRead>,
  freshSeconds = EPOCH_FRESH_MS / 1000
): Promise<EpochRead> {
  const cached = await cache.match(EPOCH_CACHE_KEY).catch(() => undefined)
  if (cached) {
    const token = await cached.text()
    if (token) return { bookmark: cached.headers.get(EPOCH_BOOKMARK_HEADER) || null, token }
  }
  const epoch = await read()
  const headers = new Headers({ 'cache-control': `public, max-age=${freshSeconds}` })
  if (epoch.bookmark) headers.set(EPOCH_BOOKMARK_HEADER, epoch.bookmark)
  await cache.put(EPOCH_CACHE_KEY, new Response(epoch.token, { headers })).catch(() => undefined)
  return epoch
}
