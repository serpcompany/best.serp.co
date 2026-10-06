import { describe, expect, it, vi } from 'vitest'
import {
  cacheKeyFor,
  EDGE_CACHE_HEADER,
  type EdgeCacheContext,
  EpochMemo,
  isCacheableRequest,
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
      { cache: cache as unknown as Cache, deploymentId, epoch: async () => epoch },
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

const page = (path = '/products/', init?: RequestInit) =>
  new Request(`https://best.serp.co${path}`, init)

describe('edge HTML cache', () => {
  it('bypasses personalized, private, mutable, and free-form requests', () => {
    expect(isCacheableRequest(page('/'))).toBe(true)
    expect(isCacheableRequest(page('/products/categories/other/?page=2'))).toBe(true)
    expect(isCacheableRequest(page('/sitemaps/directory/1.xml'))).toBe(true)
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
      { cache: edge.cache as unknown as Cache, deploymentId: 'v', epoch: async () => 'e' },
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
      { cache: edge.cache as unknown as Cache, deploymentId: 'v', epoch: async () => 'e' },
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
})

describe('catalog epoch memo', () => {
  it('reuses a fresh epoch, revalidates a stale one in the background, and reloads old ones', async () => {
    let clock = 0
    let version = 1
    const load = vi.fn(async () => `epoch-${version}`)
    const memo = new EpochMemo(load, () => clock, 1_000, 10_000)
    const background: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise) }

    expect(await memo.current(context)).toBe('epoch-1')
    version = 2
    clock = 500
    expect(await memo.current(context)).toBe('epoch-1')
    expect(load).toHaveBeenCalledTimes(1)

    clock = 2_000
    expect(await memo.current(context)).toBe('epoch-1')
    await Promise.all(background)
    expect(await memo.current(context)).toBe('epoch-2')
    expect(load).toHaveBeenCalledTimes(2)

    version = 3
    clock = 20_000
    expect(await memo.current(context)).toBe('epoch-3')
  })

  it('shares one load between concurrent requests', async () => {
    let resolve: (token: string) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<string>(done => {
          resolve = done
        })
    )
    const memo = new EpochMemo(load)
    const context = { waitUntil: () => {} }
    const both = Promise.all([memo.current(context), memo.current(context)])
    resolve('epoch-1')
    expect(await both).toEqual(['epoch-1', 'epoch-1'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares the epoch through the data-center cache', async () => {
    const cache = new MemoryCache() as unknown as Cache
    const read = vi.fn(async () => '4.2026-05-16')
    expect(await loadSharedEpoch(cache, read)).toBe('4.2026-05-16')
    expect(await loadSharedEpoch(cache, read)).toBe('4.2026-05-16')
    expect(read).toHaveBeenCalledTimes(1)
  })
})
