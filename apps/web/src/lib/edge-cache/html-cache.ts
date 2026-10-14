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
import { CodedError } from '../telemetry/coded-error'

/** How long a stored response may be reused under the same epoch and deployment. */
export const HTML_CACHE_TTL_SECONDS = 24 * 60 * 60
/** An isolate reuses its last epoch this long before revalidating it in the background. */
export const EPOCH_FRESH_MS = 30_000
/** Past this age a request waits for a fresh epoch instead of using the last one. */
export const EPOCH_MAX_STALE_MS = 5 * 60_000
/** How long a request waits for its own epoch load before it falls back (#443). */
export const EPOCH_LOAD_TIMEOUT_MS = 2_000
/**
 * How long a load nobody waits on (a background refresh, or a load its request stopped waiting
 * for) runs on in its request's `waitUntil`, under that call's 30-second limit (#443).
 */
export const EPOCH_REFRESH_TIMEOUT_MS = 25_000
/** How long a request waits for a Cache API lookup before it treats it as a miss (#443). */
export const CACHE_MATCH_TIMEOUT_MS = 1_000

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

/**
 * Where a request's epoch came from: the isolate's memo while fresh, or while stale with a
 * background refresh; the request's own load, from the data center's share or from D1; or the
 * memo's last value at any age (none: the cache is bypassed) after that load timed out or failed.
 */
export type EpochSource = 'fresh' | 'stale' | 'shared' | 'd1' | 'timeout' | 'error'

/** One request's answer from `EdgeCacheOptions.epoch`. */
export interface EpochLookup {
  /** The age of the last value a request fell back on after a timeout or a failure. */
  ageMs?: number
  /** The epoch to key on, or null when there is none: the cache is then bypassed. */
  read: EpochRead | null
  source?: EpochSource
}

export interface EdgeCacheOptions {
  /**
   * Cache API namespace for stored responses: the zone's cache, which staging's and production's
   * Workers share in each data center, so every key names the host and deployment (#397).
   */
  cache: Cache
  /** Identifies the deployed build (Worker version); markup and asset URLs change with it. */
  deploymentId: string
  /** Current catalog epoch; a null `read`, or a rejection, bypasses the cache. */
  epoch: (context: EdgeCacheContext) => Promise<EpochLookup>
  observe?: (event: EdgeCacheEvent) => void
}

/**
 * One line per request (`HIT`, `MISS` or `BYPASS`), plus one when a step fails or times out, logged
 * as it happens. A cacheable request's lines carry how long the epoch took and where it came from,
 * and how long the page lookup took (#443).
 */
export interface EdgeCacheEvent {
  epochAgeMs?: number
  epochMs?: number
  epochSource?: EpochSource
  event: 'edge_cache'
  matchMs?: number
  state: EdgeCacheState | 'store-error' | 'epoch-error' | 'epoch-timeout' | 'match-timeout'
  status?: number
}

const TIMED_OUT = Symbol('timed out')

/** `promise`'s outcome, or `TIMED_OUT` if `ms` pass first; the timer never outlives the race. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
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
 *
 * Nothing before the render waits unbounded (#443): the epoch memo answers within
 * `EPOCH_LOAD_TIMEOUT_MS`, and a page lookup slower than `CACHE_MATCH_TIMEOUT_MS` renders as a miss.
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

  const epochStartedAt = Date.now()
  let lookup: EpochLookup
  try {
    lookup = await options.epoch(context)
  } catch {
    lookup = { read: null, source: 'error' }
  }
  const timing = { epochMs: Date.now() - epochStartedAt, epochSource: lookup.source }
  if (lookup.source === 'timeout' || lookup.source === 'error') {
    observe({
      epochAgeMs: lookup.ageMs,
      event: 'edge_cache',
      state: lookup.source === 'timeout' ? 'epoch-timeout' : 'epoch-error',
      ...timing
    })
  }
  const epoch = lookup.read
  if (!epoch) {
    observe({ event: 'edge_cache', state: 'BYPASS', ...timing })
    return withState(await render(renderRequest), 'BYPASS')
  }

  const key = await cacheKeyFor(request, options.deploymentId, epoch.token)
  const matchStartedAt = Date.now()
  const matched = await settleWithin(
    options.cache.match(key).catch(() => undefined),
    CACHE_MATCH_TIMEOUT_MS
  )
  const matchMs = Date.now() - matchStartedAt
  if (matched === TIMED_OUT) {
    observe({ event: 'edge_cache', matchMs, state: 'match-timeout', ...timing })
  } else if (matched) {
    observe({ event: 'edge_cache', matchMs, state: 'HIT', status: matched.status, ...timing })
    return servedCopy(matched, request.method)
  }

  const response = await render(renderRequest, epoch)
  observe({ event: 'edge_cache', matchMs, state: 'MISS', status: response.status, ...timing })
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
  /** When the load that returned it started: a load started earlier never replaces it. */
  startedAt: number
}

/** One request's own load of the epoch, and where it found it. */
export interface LoadedEpoch {
  read: EpochRead
  source: 'shared' | 'd1'
}

/**
 * Per-isolate memo of the catalog epoch (with its bookmark, #382) with stale-while-revalidate:
 * requests inside `freshMs` reuse it, requests inside `maxStaleMs` reuse it while one background
 * refresh runs, and older values are refreshed before answering.
 *
 * Requests share only the settled value, never a load in flight (#443). A load's I/O runs in the
 * request that started it, and Workers drops its continuations when that request ends (its client
 * disconnects, or `waitUntil`'s 30 seconds run out), so another request awaiting it could wait
 * forever. Each load is therefore the calling request's own (`load` closes over its cache handle
 * and logger), and a request waits for it for at most `timeoutMs`. After a timeout or a failure
 * it falls back on the last value at any age, or on none, which bypasses the cache. A load its
 * request stopped waiting for runs on in that request's own `waitUntil`, so a slow answer still
 * lands. It, like a background refresh, runs for at most `refreshTimeoutMs`. A background refresh
 * holds its claim until it answers (#445), so an isolate runs one at a time however slow D1 is,
 * and a busy isolate starts about one per `freshMs`. One that fails or reaches that bound holds it
 * `timeoutMs` longer, so a D1 that fails fast is retried at most once per `timeoutMs`, not once
 * per stale request. A refresh whose request ended never releases its claim, which lapses
 * `refreshTimeoutMs` after it was taken, and the next stale request refreshes again. A load
 * started earlier never replaces a value a later one stored, and only a load that stores calls its
 * `stored` callback.
 */
export class EpochMemo {
  /** The background refresh's claim: no other starts before `until`. */
  private refreshClaim: { until: number } | undefined
  private value: MemoEntry | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly freshMs = EPOCH_FRESH_MS,
    private readonly maxStaleMs = EPOCH_MAX_STALE_MS,
    private readonly timeoutMs = EPOCH_LOAD_TIMEOUT_MS,
    private readonly refreshTimeoutMs = EPOCH_REFRESH_TIMEOUT_MS
  ) {}

  async current(
    context: EdgeCacheContext,
    load: () => Promise<LoadedEpoch>,
    stored: (read: EpochRead) => void = () => {}
  ): Promise<EpochLookup> {
    const value = this.value
    const startedAt = this.now()
    const age = value ? startedAt - value.fetchedAt : Number.POSITIVE_INFINITY
    if (value && age < this.freshMs) return { read: value.read, source: 'fresh' }
    if (value && age < this.maxStaleMs) {
      if (!this.refreshClaim || startedAt >= this.refreshClaim.until) {
        const claim = { until: startedAt + this.refreshTimeoutMs }
        this.refreshClaim = claim
        this.finishInBackground(context, this.loadInto(load, startedAt, stored), answered => {
          // Ends only its own claim, never one taken after this one lapsed. An answer frees it; a
          // failure or the bound backs off for `timeoutMs`.
          if (this.refreshClaim !== claim) return
          if (answered) this.refreshClaim = undefined
          else claim.until = this.now() + this.timeoutMs
        })
      }
      return { read: value.read, source: 'stale' }
    }
    const loading = this.loadInto(load, startedAt, stored)
    let loaded: LoadedEpoch | typeof TIMED_OUT
    try {
      loaded = await settleWithin(loading, this.timeoutMs)
    } catch {
      return this.fallback('error')
    }
    if (loaded !== TIMED_OUT) return loaded
    // The request stops waiting, but its own load runs on in its own `waitUntil` (never another
    // request's), so a slow but healthy D1 still updates the memo and the data center's share.
    this.finishInBackground(context, loading)
    return this.fallback('timeout')
  }

  /**
   * Keeps `loading` running in its own request's `waitUntil`, for at most `refreshTimeoutMs`,
   * then calls `ended` with whether it answered (false when it failed or ran out of time).
   */
  private finishInBackground(
    context: EdgeCacheContext,
    loading: Promise<LoadedEpoch>,
    ended: (answered: boolean) => void = () => {}
  ): void {
    context.waitUntil(
      settleWithin(loading, this.refreshTimeoutMs).then(
        outcome => ended(outcome !== TIMED_OUT),
        () => ended(false)
      )
    )
  }

  /** The last value, which another request's load may have set meanwhile, or none. */
  private fallback(source: 'timeout' | 'error'): EpochLookup {
    const value = this.value
    if (!value) return { read: null, source }
    return { ageMs: this.now() - value.fetchedAt, read: value.read, source }
  }

  private async loadInto(
    load: () => Promise<LoadedEpoch>,
    startedAt: number,
    stored: (read: EpochRead) => void
  ): Promise<LoadedEpoch> {
    const loaded = await load()
    if (!this.value || this.value.startedAt <= startedAt) {
      this.value = { fetchedAt: this.now(), read: loaded.read, startedAt }
      stored(loaded.read)
    }
    return loaded
  }
}

/**
 * The shared epoch's key names the environment (`D1_RUNTIME_ENV`): staging and production are
 * custom domains in one zone, whose cache their Workers share, so an unscoped key would let one
 * read the other's epoch (#397). Without an environment there is no key, and the share fails.
 */
function epochCacheKey(environment: string): string {
  if (!environment) {
    throw new CodedError('d1_runtime_env_invalid', 'The shared catalog epoch needs an environment.')
  }
  return `${CACHE_KEY_ORIGIN}/catalog-epoch/${encodeURIComponent(environment)}`
}
/**
 * The shared entry's body is the bare token; the bookmark travels beside it in this header
 * (#382). An entry without one (stored by a Worker version with #397's scoped key but not #382)
 * reads as no bookmark, so its renders read the primary, and such a version reads a newer entry's
 * token unchanged.
 */
const EPOCH_BOOKMARK_HEADER = 'x-d1-bookmark'

async function readSharedEpoch(cache: Cache, key: string): Promise<EpochRead | undefined> {
  const cached = await cache.match(key)
  if (!cached) return undefined
  const token = await cached.text()
  return token ? { bookmark: cached.headers.get(EPOCH_BOOKMARK_HEADER) || null, token } : undefined
}

/**
 * Shares the epoch, and the bookmark it was read at, between the isolates of one data center
 * for `freshSeconds`, so the data center reads it from D1 at most that often. A share that fails,
 * or takes longer than `CACHE_MATCH_TIMEOUT_MS`, reads D1 instead, and the share is stored in the
 * background (#443).
 */
export async function loadSharedEpoch(
  cache: Cache,
  environment: string,
  read: () => Promise<EpochRead>,
  context: EdgeCacheContext,
  freshSeconds = EPOCH_FRESH_MS / 1000
): Promise<LoadedEpoch> {
  const key = epochCacheKey(environment)
  const shared = await settleWithin(
    readSharedEpoch(cache, key).catch(() => undefined),
    CACHE_MATCH_TIMEOUT_MS
  )
  if (shared && shared !== TIMED_OUT) return { read: shared, source: 'shared' }
  const epoch = await read()
  const headers = new Headers({ 'cache-control': `public, max-age=${freshSeconds}` })
  if (epoch.bookmark) headers.set(EPOCH_BOOKMARK_HEADER, epoch.bookmark)
  context.waitUntil(cache.put(key, new Response(epoch.token, { headers })).catch(() => undefined))
  return { read: epoch, source: 'd1' }
}
