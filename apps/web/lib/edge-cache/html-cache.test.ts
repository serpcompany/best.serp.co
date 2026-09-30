import { describe, expect, it, vi } from 'vitest'
import {
  cacheKeyFor,
  EDGE_CACHE_HEADER,
  type EdgeCacheContext,
  EpochMemo,
  isCacheableRequest,
  loadSharedEpoch,
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
    for (const path of ['/api/search?q=x', '/admin/submissions/1/', '/account/', '/login/']) {
      expect(isCacheableRequest(page(path)), path).toBe(false)
    }
    expect(isCacheableRequest(page('/search/?q=video'))).toBe(false)
    expect(isCacheableRequest(page('/_next/image/?url=x'))).toBe(false)
    expect(isCacheableRequest(page('/', { method: 'POST' }))).toBe(false)
    expect(isCacheableRequest(page('/', { headers: { authorization: 'Bearer x' } }))).toBe(false)
    for (const cookie of [
      'authjs.session-token=abc',
      'theme=dark; __Secure-authjs.session-token=abc',
      'next-auth.csrf-token=abc',
      '__prerender_bypass=1'
    ]) {
      expect(isCacheableRequest(page('/', { headers: { cookie } })), cookie).toBe(false)
    }
    expect(isCacheableRequest(page('/', { headers: { cookie: 'theme=dark' } }))).toBe(true)
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
    expect(edge.cache.entries.size).toBe(2)
    const head = await edge.serve(page('/missing/', { method: 'HEAD' }))
    expect(head.status).toBe(404)
    expect(head.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(head.body).toBeNull()
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
