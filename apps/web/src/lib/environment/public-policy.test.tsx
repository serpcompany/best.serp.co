/**
 * The public crawl and analytics policy through the real request path: the Worker pipeline
 * (noindex), the edge cache's forwarded host, the root layout's analytics decision
 * (`analyticsForRequest`: Google Tag Manager and the Cloudflare Web Analytics beacon), and the
 * root shell's markup. Only the Next.js runtime is
 * stubbed: the Cloudflare env and the request headers the layout reads.
 */
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RootAppShell } from '@/components/layout/root-shell'
import { EDGE_CACHE_HEADER, withEdgeCache } from '../edge-cache/html-cache'
import { handleWorkerRequest, type WorkerRequestEnv } from '../worker/handle-request'
import { analyticsForRequest } from './request-environment'
import { SITE_ENVIRONMENT_HEADER, SMOKE_TEST_HEADER } from './site-environment'

const runtime = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  fail: false,
  host: null as string | null
}))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: async () => {
    if (runtime.fail) throw new Error('no Cloudflare context')
    return { env: runtime.env }
  }
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(runtime.host ? { host: runtime.host } : {})
}))

const GTM_CONTAINER = 'googletagmanager.com/ns.html?id=GTM-W59GNHXF'
const WEB_ANALYTICS_TOKEN = '0123456789abcdef0123456789abcdef'
const BEACON = `data-cf-beacon="{&quot;token&quot;:&quot;${WEB_ANALYTICS_TOKEN}&quot;}"`

class MemoryCache {
  readonly entries = new Map<string, Response>()

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(new Request(request).url)?.clone()
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const body = await response.arrayBuffer()
    this.entries.set(new Request(request).url, new Response(body, response))
  }
}

/** One Worker with its own edge cache; `visit` runs a request through the whole path. */
function worker(env: WorkerRequestEnv) {
  const cache = new MemoryCache()
  const pending: Promise<unknown>[] = []
  return async (url: string, init?: RequestInit) => {
    const response = await handleWorkerRequest(new Request(url, init), env, {
      configRedirects: [],
      serve: request =>
        withEdgeCache(
          request,
          { waitUntil: promise => pending.push(promise) },
          { cache: cache as unknown as Cache, deploymentId: 'v1', epoch: async () => 'e1' },
          async rendered => {
            // What OpenNext hands the root layout: the Worker's env and the forwarded headers.
            runtime.env = env as Record<string, string | undefined>
            runtime.host = rendered.headers.get('host')
            const analytics = await analyticsForRequest()
            const html = renderToStaticMarkup(
              <RootAppShell
                cloudflareWebAnalyticsToken={analytics.cloudflareWebAnalyticsToken}
                feedTitle="SERP"
                footer={null}
                gtmId={analytics.gtmId}
                header={null}
              >
                <h1>SERP</h1>
              </RootAppShell>
            )
            return new Response(`<!DOCTYPE html>${html}`, {
              headers: { 'content-type': 'text/html; charset=utf-8' }
            })
          }
        )
    })
    await Promise.all(pending.splice(0))
    return { headers: response.headers, html: await response.text(), status: response.status }
  }
}

const production = {
  CANONICAL_HOST_REDIRECT: 'off',
  CF_WEB_ANALYTICS_TOKEN: WEB_ANALYTICS_TOKEN,
  SITE_ENVIRONMENT: 'production'
}

describe('public crawl and analytics policy through the Worker and the root layout', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    runtime.fail = false
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('the root layout takes its analytics from this decision', () => {
    const layout = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8')
    expect(layout).toContain('analyticsForRequest()')
    expect(layout).toContain('gtmId={analytics.gtmId}')
    expect(layout).toContain('cloudflareWebAnalyticsToken={analytics.cloudflareWebAnalyticsToken}')
    // The layout's and pages' robots metadata and next.config.ts headers() are checked from
    // the real modules in noindex-sources.test.ts.
  })

  it('serves best.serp.co on the production Worker indexable, with both analytics', async () => {
    const visit = worker(production)
    for (const expected of ['MISS', 'HIT']) {
      const page = await visit('https://best.serp.co/')
      expect(page.headers.get(EDGE_CACHE_HEADER)).toBe(expected)
      expect(page.headers.get('x-robots-tag')).toBeNull()
      expect(page.headers.get(SITE_ENVIRONMENT_HEADER)).toBe('production')
      expect(page.html).toContain(GTM_CONTAINER)
      expect(page.html).toContain(BEACON)
      expect(page.html).toContain('src="https://static.cloudflareinsights.com/beacon.min.js"')
    }
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['malformed', 'not-a-token"><script>alert(1)</script>']
  ])(
    'renders no beacon on best.serp.co while the token is %s, and keeps Google Tag Manager',
    async (_label, token) => {
      const page = await worker({ ...production, CF_WEB_ANALYTICS_TOKEN: token })(
        'https://best.serp.co/'
      )
      expect(page.html).toContain(GTM_CONTAINER)
      expect(page.html).not.toContain('cloudflareinsights')
      expect(page.html).not.toContain('alert(1)')
    }
  )

  it('keeps Google Tag Manager on best.serp.co whatever Host spelling filled the cache', async () => {
    const visit = worker(production)
    const first = await visit('https://best.serp.co/', { headers: { host: 'BEST.SERP.CO:443' } })
    expect(first.html).toContain(GTM_CONTAINER)
    const later = await visit('https://best.serp.co/')
    expect(later.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(later.html).toContain(GTM_CONTAINER)
  })

  it.each([
    [
      'the production review URL',
      production,
      'https://best-serp-co-production.serpcompany.workers.dev/'
    ],
    [
      'the production platform host with the switch on (smoke test)',
      { ...production, CANONICAL_HOST_REDIRECT: 'on' },
      'https://best-serp-co-production.serpcompany.workers.dev/'
    ],
    [
      'staging',
      { SITE_ENVIRONMENT: 'staging' },
      'https://best-serp-co-staging.serpcompany.workers.dev/'
    ],
    ['local', { SITE_ENVIRONMENT: 'local' }, 'http://127.0.0.1:8787/'],
    ['a Worker without SITE_ENVIRONMENT on best.serp.co', {}, 'https://best.serp.co/']
  ])('serves %s noindex, without analytics even with a token', async (_label, env, url) => {
    const withToken = { ...env, CF_WEB_ANALYTICS_TOKEN: WEB_ANALYTICS_TOKEN }
    const page = await worker(withToken)(url, { headers: { [SMOKE_TEST_HEADER]: '1' } })
    expect(page.status).toBe(200)
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(page.html).not.toContain('googletagmanager.com')
    expect(page.html).not.toContain('cloudflareinsights')
  })

  it('leaves analytics out, and logs why, when the environment cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.fail = true
    runtime.host = 'best.serp.co'
    expect(await analyticsForRequest()).toEqual({})
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('site_environment_error'))
  })
})
