import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_MATCH_TIMEOUT_MS,
  cacheKeyFor,
  EDGE_CACHE_HEADER,
  type EdgeCacheContext,
  type EdgeCacheEvent,
  EPOCH_FRESH_MS,
  EPOCH_LOAD_TIMEOUT_MS,
  EPOCH_MAX_STALE_MS,
  EPOCH_REFRESH_TIMEOUT_MS,
  EpochMemo,
  type EpochRead,
  isCacheableRequest,
  type LoadedEpoch,
  loadSharedEpoch,
  renderRequestFor,
  withEdgeCache
} from './html-cache'

class MemoryCache {
  readonly entries = new Map<string, { body: ArrayBuffer; init: ResponseInit }>()

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.entries.get(new Request(request).url)
    if (!entry) return undefined
    return new Response(entry.body.byteLength ? entry.body : null, entry.init)
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(new Request(request).url, {
      body: await response.arrayBuffer(),
      init: {
        headers: new Headers(response.headers),
        status: response.status,
        statusText: response.statusText
      }
    })
  }
}

/** An epoch read with no bookmark, as the edge cache sees it. */
const read = (token: string): EpochRead => ({ bookmark: null, token })

function harness(options: { deploymentId?: string; epoch?: string | null } = {}) {
  const cache = new MemoryCache()
  const pending: Promise<unknown>[] = []
  const context: EdgeCacheContext = { waitUntil: promise => pending.push(promise) }
  let epoch = options.epoch === undefined ? '7.2026-05-16' : options.epoch
  let renders = 0
  const serve = async (
    request: Request,
    response: () => Response = () =>
      new Response(`<html>render ${renders}</html>`, {
        headers: {
          'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          'content-type': 'text/html; charset=utf-8',
          vary: 'rsc, next-router-state-tree'
        }
      }),
    deploymentId = options.deploymentId ?? 'version-a'
  ) => {
    const result = await withEdgeCache(
      request,
      context,
      {
        cache: cache as unknown as Cache,
        deploymentId,
        epoch: async () => ({ read: epoch === null ? null : read(epoch) })
      },
      async () => {
        renders += 1
        return response()
      }
    )
    await Promise.all(pending.splice(0))
    return result
  }
  return {
    cache,
    get renders() {
      return renders
    },
    serve,
    setEpoch(value: string | null) {
      epoch = value
    }
  }
}

/** The shared epoch's key before #397, which named no environment. */
const UNSCOPED_EPOCH_KEY = 'https://html-cache.invalid/catalog-epoch'

const page = (path = '/products/', init?: RequestInit) =>
  new Request(`https://best.serp.co${path}`, init)

describe('edge HTML cache', () => {
  it('bypasses personalized, private, mutable, and free-form requests', () => {
    expect(isCacheableRequest(page('/'))).toBe(true)
    expect(isCacheableRequest(page('/products/categories/other/?page=2'))).toBe(true)
    expect(isCacheableRequest(page('/sitemap-products.xml'))).toBe(true)
    expect(isCacheableRequest(page('/accounting-tools/'))).toBe(true)
    for (const path of [
      '/api/search?q=x',
      '/api/auth/get-session',
      '/api/auth/sign-in/email-otp',
      '/admin/',
      '/admin/submissions/1/',
      '/ADMIN/',
      '/account/',
      '/Account/',
      '/login/'
    ]) {
      expect(isCacheableRequest(page(path)), path).toBe(false)
    }
    expect(isCacheableRequest(page('/search/?q=video'))).toBe(false)
    expect(isCacheableRequest(page('/_next/image/?url=x'))).toBe(false)
    expect(isCacheableRequest(page('/', { method: 'POST' }))).toBe(false)
    expect(isCacheableRequest(page('/', { headers: { authorization: 'Bearer x' } }))).toBe(false)
    for (const cookie of [
      'better-auth.session_token=abc.sig',
      'theme=dark; __Secure-better-auth.session_token=abc.sig',
      '__Host-better-auth.session_token=abc',
      'better-auth.session_data=abc',
      'better-auth.dont_remember=true',
      'better-auth-session_token=abc',
      '__prerender_bypass=1'
    ]) {
      expect(isCacheableRequest(page('/', { headers: { cookie } })), cookie).toBe(false)
    }
    for (const cookie of ['theme=dark', 'not-better-auth=1', 'authjs.session-token=retired']) {
      expect(isCacheableRequest(page('/', { headers: { cookie } })), cookie).toBe(true)
    }
  })

  // serpcompany/best.serp.co#60: pages under auth are never served from the edge cache.
  it('never serves a signed-in request from the cache and never stores its response', async () => {
    const edge = harness()
    const anonymous = await edge.serve(page('/products/'))
    expect(anonymous.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(edge.cache.entries.size).toBe(1)
    const stored = [...edge.cache.entries.keys()]

    for (const cookie of [
      'better-auth.session_token=token.signature',
      'theme=dark; __Secure-better-auth.session_token=token.signature'
    ]) {
      const rendersBefore = edge.renders
      const signedIn = await edge.serve(
        page('/products/', { headers: { cookie } }),
        () => new Response('<html>signed in</html>', { headers: { 'set-cookie': 'x=1' } })
      )
      expect(signedIn.headers.get(EDGE_CACHE_HEADER), cookie).toBe('BYPASS')
      expect(await signedIn.text()).toBe('<html>signed in</html>')
      expect(edge.renders).toBe(rendersBefore + 1)
    }
    // Nothing new was stored, and the anonymous entry is unchanged.
    expect([...edge.cache.entries.keys()]).toEqual(stored)
    const hit = await edge.serve(page('/products/'))
    expect(hit.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(await hit.text()).toBe('<html>render 1</html>')
  })

  it('stores a miss and serves the same bytes on a hit without rendering', async () => {
    const edge = harness()
    const miss = await edge.serve(page())
    expect(miss.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(await miss.text()).toBe('<html>render 1</html>')

    const hit = await edge.serve(page())
    expect(hit.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(await hit.text()).toBe('<html>render 1</html>')
    expect(edge.renders).toBe(1)
    // Visitors keep the origin cache policy; only the stored copy is public.
    expect(hit.headers.get('cache-control')).toBe(
      'private, no-cache, no-store, max-age=0, must-revalidate'
    )
    expect(hit.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const [stored] = [...edge.cache.entries.values()]
    expect(new Headers(stored?.init.headers).get('cache-control')).toBe('public, max-age=86400')
  })

  it('keys entries by catalog epoch, deployment, host, path, and query', async () => {
    const edge = harness()
    await edge.serve(page())
    await edge.serve(page('/products/?page=2'))
    await edge.serve(new Request('https://best-serp-co-staging.example.workers.dev/products/'))
    expect(edge.renders).toBe(3)

    edge.setEpoch('8.2026-05-16')
    expect((await edge.serve(page())).headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    await edge.serve(page(), undefined, 'version-b')
    expect(edge.renders).toBe(5)
    expect((await edge.serve(page(), undefined, 'version-b')).headers.get(EDGE_CACHE_HEADER)).toBe(
      'HIT'
    )
  })

  // #397: staging and production share the serp.co zone's cache, and each Worker answers only
  // its own hosts, so the host in every key keeps their pages apart, even under one deployment
  // and epoch token.
  it("never serves one environment's page to another through the zone's cache", async () => {
    const edge = harness()
    const staging = new Request('https://staging.best.serp.co/products/')
    await edge.serve(staging, () => new Response('staging catalog'))
    const production = await edge.serve(
      page('/products/'),
      () => new Response('production catalog')
    )
    expect(production.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(await production.text()).toBe('production catalog')
    expect(await (await edge.serve(staging)).text()).toBe('staging catalog')
    expect(edge.renders).toBe(2)
  })

  it('answers a stored redirect only for the exact URL that produced it', async () => {
    const edge = harness()
    const moved = () =>
      new Response(null, {
        headers: { location: '/products/categories/video-downloaders/' },
        status: 308
      })
    await edge.serve(page('/categories/video-downloaders'), moved)

    // The slash variant and another query are different keys, so they render themselves.
    const slashed = await edge.serve(page('/categories/video-downloaders/'))
    expect(slashed.status).toBe(200)
    expect(slashed.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    const withQuery = await edge.serve(page('/categories/video-downloaders?ref=1'))
    expect(withQuery.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(edge.renders).toBe(3)

    const hit = await edge.serve(page('/categories/video-downloaders'))
    expect(hit.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(hit.status).toBe(308)
    expect(hit.headers.get('location')).toBe('/products/categories/video-downloaders/')
    expect(edge.renders).toBe(3)
  })

  it('keeps React Server Components payloads apart from documents and router states', async () => {
    const documentKey = await cacheKeyFor(page(), 'v', 'e')
    const rscKey = await cacheKeyFor(page('/', { headers: { rsc: '1' } }), 'v', 'e')
    const otherTree = await cacheKeyFor(
      page('/', { headers: { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' } }),
      'v',
      'e'
    )
    expect(new Set([documentKey.url, rscKey.url, otherTree.url]).size).toBe(3)
    expect(await cacheKeyFor(page('/', { headers: { rsc: '1' } }), 'v', 'e')).toEqual(rscKey)
  })

  it('never stores errors, cookies, or HEAD misses, and serves HEAD from stored entries', async () => {
    const edge = harness()
    await edge.serve(page('/broken/'), () => new Response('failed', { status: 500 }))
    await edge.serve(
      page('/cookie/'),
      () => new Response('hi', { headers: { 'set-cookie': 'session=1' } })
    )
    await edge.serve(page('/head/', { method: 'HEAD' }))
    expect(edge.cache.entries.size).toBe(0)

    await edge.serve(page('/missing/'), () => new Response('not found', { status: 404 }))
    await edge.serve(page('/moved/'), () =>
      Response.redirect('https://best.serp.co/products/', 308)
    )
    // An unpublished listing's 410 gone page is public and epoch-keyed like any page (#64).
    await edge.serve(page('/products/gone.example/'), () => new Response('gone', { status: 410 }))
    expect(edge.cache.entries.size).toBe(3)
    const head = await edge.serve(page('/missing/', { method: 'HEAD' }))
    expect(head.status).toBe(404)
    expect(head.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(head.body).toBeNull()
  })

  it('renders a cacheable request with allowlisted headers only', () => {
    const forwarded = renderRequestFor(
      page('/products/?page=2', {
        headers: {
          accept: 'text/html',
          'content-security-policy': "script-src 'nonce-attacker'",
          cookie: 'theme=dark',
          host: 'best.serp.co',
          'next-router-state-tree': '%5B%22%22%5D',
          rsc: '1',
          'user-agent': 'Googlebot/2.1',
          'x-forwarded-host': 'attacker.example',
          'x-middleware-subrequest': 'middleware',
          'x-nonce': 'attacker',
          'x-opennext-initial-url': '/admin/'
        },
        method: 'HEAD'
      })
    )
    expect(forwarded.url).toBe('https://best.serp.co/products/?page=2')
    expect(forwarded.method).toBe('HEAD')
    expect(Object.fromEntries(forwarded.headers)).toEqual({
      accept: 'text/html',
      host: 'best.serp.co',
      'next-router-state-tree': '%5B%22%22%5D',
      rsc: '1',
      'user-agent': 'Googlebot/2.1'
    })
  })

  // PR #47 review: the root layout loads analytics only for the `best.serp.co` Host, so a
  // render that saw another spelling of the keyed host would store an analytics-free page.
  it('renders with the host the cache key uses, whatever Host the client sent', async () => {
    for (const host of ['best.serp.co:443', 'BEST.SERP.CO', 'attacker.example', undefined]) {
      const request = page('/products/', host ? { headers: { host } } : undefined)
      const forwarded = renderRequestFor(request)
      expect(forwarded.headers.get('host'), String(host)).toBe('best.serp.co')
      const key = new URL((await cacheKeyFor(request, 'v', 'e')).url)
      expect(key.pathname.split('/')[4], String(host)).toBe(forwarded.headers.get('host'))
    }
    const port = renderRequestFor(new Request('http://127.0.0.1:8787/about/'))
    expect(port.headers.get('host')).toBe('127.0.0.1:8787')
  })

  // serpcompany/best.serp.co#41 review: a client-sent `x-nonce` was rendered into a page that
  // the cache then served to every visitor for 24 hours.
  it('stores nothing a request header put into the page', async () => {
    const edge = harness()
    const reflect = (request: Request) =>
      new Response(`<script nonce="${request.headers.get('x-nonce') ?? ''}"></script>`)
    const poisoned = await withEdgeCache(
      page('/products/', { headers: { 'x-nonce': 'ATTACKER' } }),
      { waitUntil: promise => void promise },
      {
        cache: edge.cache as unknown as Cache,
        deploymentId: 'v',
        epoch: async () => ({ read: read('e') })
      },
      async request => reflect(request)
    )
    expect(poisoned.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(await poisoned.text()).toBe('<script nonce=""></script>')
    await vi.waitFor(() => expect(edge.cache.entries.size).toBe(1))
    const [stored] = [...edge.cache.entries.values()]
    expect(new TextDecoder().decode(stored?.body)).toBe('<script nonce=""></script>')
  })

  it('renders a bypassed request as sent; its response is never stored', async () => {
    const seen: Request[] = []
    const edge = harness()
    await withEdgeCache(
      page('/search/?q=x', { headers: { 'x-nonce': 'n', cookie: 'better-auth.session_token=a' } }),
      { waitUntil: () => {} },
      {
        cache: edge.cache as unknown as Cache,
        deploymentId: 'v',
        epoch: async () => ({ read: read('e') })
      },
      async request => {
        seen.push(request)
        return new Response('results')
      }
    )
    expect(seen[0]?.headers.get('x-nonce')).toBe('n')
    expect(edge.cache.entries.size).toBe(0)
  })

  it('bypasses the cache when the catalog epoch is unavailable', async () => {
    const edge = harness({ epoch: null })
    expect((await edge.serve(page())).headers.get(EDGE_CACHE_HEADER)).toBe('BYPASS')
    expect(edge.cache.entries.size).toBe(0)

    const failing = await withEdgeCache(
      page(),
      { waitUntil: () => {} },
      {
        cache: new MemoryCache() as unknown as Cache,
        deploymentId: 'v',
        epoch: async () => {
          throw new Error('D1 unavailable')
        }
      },
      async () => new Response('rendered')
    )
    expect(failing.headers.get(EDGE_CACHE_HEADER)).toBe('BYPASS')
    expect(await failing.text()).toBe('rendered')
  })

  // #382: only a miss's render learns the epoch (and bookmark) its key names, so only it may read
  // a replica; a signed-in, private or epoch-less request renders without one.
  it('hands a miss its epoch and bookmark, and a bypassed render neither', async () => {
    const epoch: EpochRead = { bookmark: '00000042-bookmark', token: '7.2026-05-16' }
    const options = {
      cache: new MemoryCache() as unknown as Cache,
      deploymentId: 'v',
      epoch: vi.fn(async () => ({ read: epoch }))
    }
    const seen: Array<EpochRead | undefined> = []
    const render = async (_request: Request, given?: EpochRead) => {
      seen.push(given)
      return new Response('page')
    }
    const context = { waitUntil: () => {} }
    await withEdgeCache(page('/products/alpha/'), context, options, render)
    await withEdgeCache(
      page('/products/alpha/', { headers: { cookie: 'better-auth.session_token=a.b' } }),
      context,
      options,
      render
    )
    await withEdgeCache(page('/account/'), context, options, render)
    await withEdgeCache(
      page('/products/alpha/'),
      context,
      { ...options, epoch: vi.fn(async () => ({ read: null })) },
      render
    )
    expect(seen).toEqual([epoch, undefined, undefined, undefined])
    // A bypassed request never reads the epoch at all.
    expect(options.epoch).toHaveBeenCalledTimes(1)
  })
})

describe('edge HTML cache timeouts (#443)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a page lookup that never answers as a miss at the timeout, and logs it', async () => {
    vi.useFakeTimers()
    const events: EdgeCacheEvent[] = []
    const cache = { match: vi.fn(() => new Promise(() => {})), put: vi.fn(async () => {}) }
    const answer = withEdgeCache(
      page(),
      { waitUntil: () => {} },
      {
        cache: cache as unknown as Cache,
        deploymentId: 'v',
        epoch: async () => ({ read: read('e'), source: 'fresh' }),
        observe: event => events.push(event)
      },
      async () => new Response('rendered')
    )
    await vi.advanceTimersByTimeAsync(CACHE_MATCH_TIMEOUT_MS)
    const response = await answer
    expect(response.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(await response.text()).toBe('rendered')
    const timing = { epochMs: 0, epochSource: 'fresh', matchMs: CACHE_MATCH_TIMEOUT_MS }
    expect(events).toEqual([
      { event: 'edge_cache', state: 'match-timeout', ...timing },
      { event: 'edge_cache', state: 'MISS', status: 200, ...timing }
    ])
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  // The isolate's memo and its loads, as `catalogEpochReader` wires them, in front of a render.
  function isolate() {
    const cache = new MemoryCache()
    const events: EdgeCacheEvent[] = []
    const memo = new EpochMemo()
    const pending: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
    const serve = (load: () => Promise<LoadedEpoch>) =>
      withEdgeCache(
        page(),
        context,
        {
          cache: cache as unknown as Cache,
          deploymentId: 'v',
          epoch: requestContext => memo.current(requestContext, load),
          observe: event => events.push(event)
        },
        async () => new Response('page')
      )
    return { events, pending, serve }
  }

  it('answers at the timeout when its epoch load never settles, and never leaves the isolate stuck', async () => {
    vi.useFakeTimers()
    const edge = isolate()
    // A fresh isolate's first load never settles: the request bypasses the cache at the timeout.
    const first = edge.serve(stuck)
    await vi.advanceTimersByTimeAsync(EPOCH_LOAD_TIMEOUT_MS)
    expect((await first).headers.get(EDGE_CACHE_HEADER)).toBe('BYPASS')
    // Its load runs on in its own request's `waitUntil`, in case it answers late.
    expect(edge.pending.splice(0)).toHaveLength(1)
    const timedOut = { epochMs: EPOCH_LOAD_TIMEOUT_MS, epochSource: 'timeout' }
    expect(edge.events.splice(0)).toEqual([
      { event: 'edge_cache', state: 'epoch-timeout', ...timedOut },
      { event: 'edge_cache', state: 'BYPASS', ...timedOut }
    ])

    // The next request loads the epoch itself, and later ones reuse it.
    const load = vi.fn(async () => loaded('e1'))
    expect((await edge.serve(load)).headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    await Promise.all(edge.pending.splice(0))
    expect((await edge.serve(load)).headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(load).toHaveBeenCalledTimes(1)
    expect(edge.events.splice(0)).toEqual([
      {
        epochMs: 0,
        epochSource: 'd1',
        event: 'edge_cache',
        matchMs: 0,
        state: 'MISS',
        status: 200
      },
      {
        epochMs: 0,
        epochSource: 'fresh',
        event: 'edge_cache',
        matchMs: 0,
        state: 'HIT',
        status: 200
      }
    ])

    // Past the stale window, a load that never settles falls back on the last epoch: still a hit.
    vi.advanceTimersByTime(EPOCH_MAX_STALE_MS)
    const late = edge.serve(stuck)
    await vi.advanceTimersByTimeAsync(EPOCH_LOAD_TIMEOUT_MS)
    expect((await late).headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(edge.events[0]).toEqual({
      epochAgeMs: EPOCH_MAX_STALE_MS + EPOCH_LOAD_TIMEOUT_MS,
      event: 'edge_cache',
      state: 'epoch-timeout',
      ...timedOut
    })
  })

  // #444 review: a load cut off with its request never landed, so a slow D1 kept the isolate on an
  // old epoch, and every request waited the full timeout.
  it('lands a load that answers after its request stopped waiting, and the next request uses it', async () => {
    vi.useFakeTimers()
    const edge = isolate()
    // The epoch read takes 3 seconds: the request bypasses at the timeout, and its load runs on.
    const slow = () => new Promise<LoadedEpoch>(done => setTimeout(() => done(loaded('e1')), 3_000))
    const first = edge.serve(slow)
    await vi.advanceTimersByTimeAsync(EPOCH_LOAD_TIMEOUT_MS)
    expect((await first).headers.get(EDGE_CACHE_HEADER)).toBe('BYPASS')
    // Workers cancels a request's I/O once it has answered, unless its `waitUntil` holds it.
    expect(edge.pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all(edge.pending.splice(0))
    edge.events.splice(0)

    // The next request uses the epoch that landed, without waiting or loading.
    const load = vi.fn(stuck)
    expect((await edge.serve(load)).headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(load).not.toHaveBeenCalled()
    expect(edge.events).toEqual([
      {
        epochMs: 0,
        epochSource: 'fresh',
        event: 'edge_cache',
        matchMs: 0,
        state: 'MISS',
        status: 200
      }
    ])
  })
})

/** One request's load of the epoch from D1, as the memo sees it. */
const loaded = (token: string, bookmark: string | null = null): LoadedEpoch => ({
  read: { bookmark, token },
  source: 'd1'
})

/** A load whose request was canceled: its continuations never run, so it never settles (#443). */
const stuck = () => new Promise<LoadedEpoch>(() => {})

describe('catalog epoch memo', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses a fresh epoch, revalidates a stale one in the background, and reloads old ones', async () => {
    let clock = 0
    let version = 1
    const load = vi.fn(async () => loaded(`epoch-${version}`))
    const memo = new EpochMemo(() => clock, 1_000, 10_000)
    const background: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise) }

    expect(await memo.current(context, load)).toEqual({ read: read('epoch-1'), source: 'd1' })
    version = 2
    clock = 500
    expect(await memo.current(context, load)).toEqual({ read: read('epoch-1'), source: 'fresh' })
    expect(load).toHaveBeenCalledTimes(1)

    clock = 2_000
    expect(await memo.current(context, load)).toEqual({ read: read('epoch-1'), source: 'stale' })
    await Promise.all(background)
    expect(await memo.current(context, load)).toEqual({ read: read('epoch-2'), source: 'fresh' })
    expect(load).toHaveBeenCalledTimes(2)

    version = 3
    clock = 20_000
    expect((await memo.current(context, load)).read).toEqual(read('epoch-3'))
  })

  it('keeps each epoch with the bookmark it was read at (#382)', async () => {
    let clock = 0
    let version = 1
    const load = vi.fn(async () => loaded(`epoch-${version}`, `bookmark-${version}`))
    const memo = new EpochMemo(() => clock, 1_000, 10_000)
    const background: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise) }

    expect((await memo.current(context, load)).read).toEqual({
      bookmark: 'bookmark-1',
      token: 'epoch-1'
    })
    version = 2
    clock = 2_000
    // The stale epoch is served with its own bookmark while the refresh runs, never mixed.
    expect((await memo.current(context, load)).read).toEqual({
      bookmark: 'bookmark-1',
      token: 'epoch-1'
    })
    await Promise.all(background)
    expect((await memo.current(context, load)).read).toEqual({
      bookmark: 'bookmark-2',
      token: 'epoch-2'
    })
  })

  // #443: a load's I/O belongs to the request that started it, so no other request awaits it.
  it("never makes a request wait on another request's load", async () => {
    let clock = 0
    let finish: (value: LoadedEpoch) => void = () => {}
    const memo = new EpochMemo(() => clock)
    const context = { waitUntil: () => {} }
    // What the isolate shares with bypassed renders (`shareCatalogEpochToken`).
    const shared: string[] = []
    const share = (epoch: EpochRead) => shared.push(epoch.token)
    const slow = memo.current(
      context,
      () =>
        new Promise<LoadedEpoch>(done => {
          finish = done
        }),
      share
    )
    clock = 1
    // A concurrent request loads for itself and answers while the first load is still out.
    const concurrent = vi.fn(async () => loaded('epoch-2'))
    expect(await memo.current(context, concurrent, share)).toEqual({
      read: read('epoch-2'),
      source: 'd1'
    })
    // The first load, started earlier, answers its own request but never replaces a newer epoch,
    // and never rolls the shared token back to its own.
    finish(loaded('epoch-1'))
    expect((await slow).read).toEqual(read('epoch-1'))
    expect(await memo.current(context, concurrent, share)).toEqual({
      read: read('epoch-2'),
      source: 'fresh'
    })
    expect(concurrent).toHaveBeenCalledTimes(1)
    expect(shared).toEqual(['epoch-2'])
  })

  it('answers at the timeout when a load never settles, and the next request loads again', async () => {
    vi.useFakeTimers()
    const memo = new EpochMemo()
    const context = { waitUntil: () => {} }
    const first = memo.current(context, stuck)
    await vi.advanceTimersByTimeAsync(EPOCH_LOAD_TIMEOUT_MS)
    // No epoch yet: the request bypasses the cache.
    expect(await first).toEqual({ read: null, source: 'timeout' })
    const load = vi.fn(async () => loaded('epoch-1'))
    expect(await memo.current(context, load)).toEqual({ read: read('epoch-1'), source: 'd1' })
  })

  it('falls back on the last epoch at any age after a timeout or a failure', async () => {
    vi.useFakeTimers()
    let clock = 0
    const memo = new EpochMemo(() => clock, 1_000, 10_000, 2_000)
    const context = { waitUntil: () => {} }
    await memo.current(context, async () => loaded('epoch-1'))
    clock = 60_000
    const timedOut = memo.current(context, stuck)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await timedOut).toEqual({ ageMs: 60_000, read: read('epoch-1'), source: 'timeout' })
    const failing = async (): Promise<LoadedEpoch> => {
      throw new Error('D1 unavailable')
    }
    expect(await memo.current(context, failing)).toEqual({
      ageMs: 60_000,
      read: read('epoch-1'),
      source: 'error'
    })
    // Without an epoch, a failure bypasses the cache.
    expect(await new EpochMemo().current(context, failing)).toEqual({ read: null, source: 'error' })
  })

  it('runs one background refresh at a time, bounded, and releases its claim when it ends', async () => {
    vi.useFakeTimers()
    let clock = 0
    const memo = new EpochMemo(() => clock, 1_000, 10_000, 2_000)
    const background: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise) }
    await memo.current(context, async () => loaded('epoch-1'))

    const refresh = vi.fn(stuck)
    const stale = { read: read('epoch-1'), source: 'stale' }
    clock = 1_500
    expect(await memo.current(context, refresh)).toEqual(stale)
    clock = 3_000
    expect(await memo.current(context, refresh)).toEqual(stale)
    expect(refresh).toHaveBeenCalledTimes(1)
    // A slow refresh runs on past the request's timeout, and ends under `waitUntil`'s 30 seconds.
    let ended = false
    Promise.all(background).then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(EPOCH_REFRESH_TIMEOUT_MS - 2_000)
    expect(ended).toBe(true)

    // Its bound released the claim, and so does a refresh that fails: the next stale request
    // refreshes again.
    clock = 3_500
    const failing = vi.fn(async (): Promise<LoadedEpoch> => {
      throw new Error('D1 unavailable')
    })
    expect(await memo.current(context, failing)).toEqual(stale)
    await Promise.all(background)
    const retry = vi.fn(async () => loaded('epoch-2'))
    expect(await memo.current(context, retry)).toEqual(stale)
    await Promise.all(background)
    expect(await memo.current(context, retry)).toEqual({ read: read('epoch-2'), source: 'fresh' })
    expect(failing).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  // #445: a claim that lapsed after 2 seconds let a slow D1 start a refresh every 2 seconds.
  it('keeps one background refresh in flight while D1 is slow', async () => {
    vi.useFakeTimers()
    const memo = new EpochMemo()
    const context = { waitUntil: () => {} }
    await memo.current(context, async () => loaded('epoch-1'))
    await vi.advanceTimersByTimeAsync(EPOCH_FRESH_MS)

    let inFlight = 0
    let mostInFlight = 0
    const slowD1 = vi.fn(async () => {
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      await new Promise(done => setTimeout(done, 10_000))
      inFlight -= 1
      return loaded('epoch-2')
    })
    // A request every 500 ms while the 10-second read is out: each is served the stale epoch.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
      expect(await memo.current(context, slowD1)).toEqual({
        read: read('epoch-1'),
        source: 'stale'
      })
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(mostInFlight).toBe(1)
    expect(slowD1).toHaveBeenCalledTimes(1)
    expect(await memo.current(context, slowD1)).toEqual({ read: read('epoch-2'), source: 'fresh' })
  })

  it('lets a claim lapse at its bound even if the refresh never ends, and keeps a newer claim', async () => {
    vi.useFakeTimers()
    let clock = 0
    const memo = new EpochMemo(() => clock, 1_000, 60_000)
    const context = { waitUntil: () => {} }
    await memo.current(context, async () => loaded('epoch-1'))

    const refresh = vi.fn(stuck)
    clock = 1_000
    await memo.current(context, refresh)
    // Still out just before its bound: the claim holds.
    await vi.advanceTimersByTimeAsync(EPOCH_REFRESH_TIMEOUT_MS - 1)
    clock = 1_000 + EPOCH_REFRESH_TIMEOUT_MS - 1
    await memo.current(context, refresh)
    expect(refresh).toHaveBeenCalledTimes(1)
    // At the bound the claim lapses on the clock alone, as for a refresh whose request was cut
    // off and never releases it, and the next stale request refreshes.
    clock = 1_000 + EPOCH_REFRESH_TIMEOUT_MS
    await memo.current(context, refresh)
    expect(refresh).toHaveBeenCalledTimes(2)
    // The first refresh's bound ends after that, and releases only its own claim.
    await vi.advanceTimersByTimeAsync(1)
    await memo.current(context, refresh)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

describe('shared catalog epoch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** One request's load through the share, with the share's background store finished. */
  async function share(cache: Cache, environment: string, load: () => Promise<EpochRead>) {
    const background: Promise<unknown>[] = []
    const loadedEpoch = await loadSharedEpoch(cache, environment, load, {
      waitUntil: promise => background.push(promise)
    })
    await Promise.all(background)
    return loadedEpoch
  }

  it('shares the epoch and its bookmark through the data-center cache', async () => {
    const cache = new MemoryCache() as unknown as Cache
    const load = vi.fn(async () => ({ bookmark: '00000042-abc', token: '4.2026-05-16' }))
    const shared = { bookmark: '00000042-abc', token: '4.2026-05-16' }
    expect(await share(cache, 'production', load)).toEqual({ read: shared, source: 'd1' })
    expect(await share(cache, 'production', load)).toEqual({ read: shared, source: 'shared' })
    expect(load).toHaveBeenCalledTimes(1)
    // The body stays the bare token, which a Worker version without #382 reads unchanged.
    const [entry] = [...(cache as unknown as MemoryCache).entries.values()]
    expect(new TextDecoder().decode(entry?.body)).toBe('4.2026-05-16')
  })

  it('reads an entry without a bookmark (a version with #397 but not #382) as no bookmark', async () => {
    const cache = new MemoryCache()
    await cache.put(
      `${UNSCOPED_EPOCH_KEY}/production`,
      new Response('4.2026-05-16', { headers: { 'cache-control': 'public, max-age=30' } })
    )
    const load = vi.fn(async () => ({ bookmark: 'unused', token: 'unused' }))
    expect((await share(cache as unknown as Cache, 'production', load)).read).toEqual(
      read('4.2026-05-16')
    )
    expect(load).not.toHaveBeenCalled()
  })

  it('shares an epoch read without a bookmark as one', async () => {
    const cache = new MemoryCache() as unknown as Cache
    const load = vi.fn(async () => read('4.2026-05-16'))
    await share(cache, 'production', load)
    expect((await share(cache, 'production', load)).read).toEqual(read('4.2026-05-16'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  // #443: neither Cache API call can hold the request; the store never runs in its path.
  it('reads D1 when the share does not answer in time, and stores the share in the background', async () => {
    vi.useFakeTimers()
    const hung = {
      match: vi.fn(() => new Promise(() => {})),
      put: vi.fn(() => new Promise(() => {}))
    }
    const background: Promise<unknown>[] = []
    const load = vi.fn(async () => read('4.2026-05-16'))
    const answer = loadSharedEpoch(hung as unknown as Cache, 'production', load, {
      waitUntil: promise => background.push(promise)
    })
    await vi.advanceTimersByTimeAsync(CACHE_MATCH_TIMEOUT_MS)
    expect(await answer).toEqual({ read: read('4.2026-05-16'), source: 'd1' })
    expect(hung.put).toHaveBeenCalledTimes(1)
    expect(background).toHaveLength(1)
  })

  // #397: staging and production share the serp.co zone's cache.
  it("never shares one environment's epoch with another", async () => {
    const zone = new MemoryCache()
    const cache = zone as unknown as Cache
    // A Worker version from before #397 shared its epoch under one key for every environment.
    await zone.put(UNSCOPED_EPOCH_KEY, new Response('21.2026-10-10'))
    const staging = vi.fn(async () => ({ bookmark: 'staging-b', token: '21.2026-10-10' }))
    const production = vi.fn(async () => ({ bookmark: 'production-b', token: '18.2026-10-01' }))

    for (let round = 0; round < 2; round += 1) {
      expect((await share(cache, 'staging', staging)).read).toEqual({
        bookmark: 'staging-b',
        token: '21.2026-10-10'
      })
      expect((await share(cache, 'production', production)).read).toEqual({
        bookmark: 'production-b',
        token: '18.2026-10-01'
      })
    }
    expect(staging).toHaveBeenCalledTimes(1)
    expect(production).toHaveBeenCalledTimes(1)
    expect([...zone.entries.keys()].sort()).toEqual([
      UNSCOPED_EPOCH_KEY,
      `${UNSCOPED_EPOCH_KEY}/production`,
      `${UNSCOPED_EPOCH_KEY}/staging`
    ])
  })

  it('shares no epoch without an environment, and reads none', async () => {
    const zone = new MemoryCache()
    await zone.put(UNSCOPED_EPOCH_KEY, new Response('21.2026-10-10'))
    const load = vi.fn(async () => read('18.2026-10-01'))
    await expect(share(zone as unknown as Cache, '', load)).rejects.toMatchObject({
      code: 'd1_runtime_env_invalid'
    })
    expect(load).not.toHaveBeenCalled()
    expect([...zone.entries.keys()]).toEqual([UNSCOPED_EPOCH_KEY])
  })
})
