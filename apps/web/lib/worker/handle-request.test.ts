import { describe, expect, it, vi } from 'vitest'
import { EDGE_CACHE_HEADER, withEdgeCache } from '../edge-cache/html-cache'
import {
  NON_PRODUCTION_ROBOTS_TXT,
  SMOKE_TEST_HEADER,
  WORKER_VERSION_HEADER
} from '../environment/site-environment'
import { handleWorkerRequest, type WorkerRequestEnv } from './handle-request'

const production = 'https://best.serp.co'
const review = 'https://best-serp-co-production.serpcompany.workers.dev'
const staging = 'https://best-serp-co-staging.serpcompany.workers.dev'
const version = { id: '9d6c0a52-1111-4222-8333-444455556666' }
const productionEnv: WorkerRequestEnv = {
  CANONICAL_HOST_REDIRECT: 'off',
  CF_VERSION_METADATA: version,
  SITE_ENVIRONMENT: 'production'
}
const configRedirects = [/^(?!\/_next)\/products(?:\/([^/]+?))\/reviews(?:\/)?$/]

function pipeline() {
  const serve = vi.fn(async (request: Request) => {
    const robots = new URL(request.url).pathname === '/robots.txt'
    return new Response(robots ? 'User-Agent: *\nAllow: /\n' : '<html>page</html>')
  })
  return { configRedirects, serve }
}

function run(url: string, env: WorkerRequestEnv, init?: RequestInit) {
  const handler = pipeline()
  return {
    handler,
    response: handleWorkerRequest(new Request(url, init), env, handler)
  }
}

describe('Worker request pipeline', () => {
  it('leaves public production indexable and versioned', async () => {
    const { handler, response } = run(`${production}/robots.txt`, productionEnv)
    const served = await response
    expect(await served.text()).toBe('User-Agent: *\nAllow: /\n')
    expect(served.headers.get('x-robots-tag')).toBeNull()
    expect(served.headers.get(WORKER_VERSION_HEADER)).toBe(version.id)
    expect(handler.serve).toHaveBeenCalledOnce()
  })

  it.each([
    ['staging', staging, { SITE_ENVIRONMENT: 'staging' }],
    ['the production review URL', review, productionEnv],
    ['a Worker without SITE_ENVIRONMENT', production, { CF_VERSION_METADATA: version }],
    ['a misspelled SITE_ENVIRONMENT', production, { SITE_ENVIRONMENT: 'Production' }]
  ])('keeps %s out of indexes', async (_label, origin, env: WorkerRequestEnv) => {
    const robots = run(`${origin}/robots.txt`, env)
    const answered = await robots.response
    expect(await answered.text()).toBe(NON_PRODUCTION_ROBOTS_TXT)
    expect(answered.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(robots.handler.serve).not.toHaveBeenCalled()

    for (const path of ['/', '/sitemap-index.xml', '/about']) {
      const response = await run(`${origin}${path}`, env).response
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow')
    }
  })

  it('answers the trailing-slash rule before the non-production robots.txt', async () => {
    const response = await run(`${staging}/robots.txt/`, { SITE_ENVIRONMENT: 'staging' }).response
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/robots.txt')
  })

  describe('with CANONICAL_HOST_REDIRECT=on', () => {
    const env = { ...productionEnv, CANONICAL_HOST_REDIRECT: 'on' }

    it('redirects workers.dev to best.serp.co in one hop, before the slash rule and the cache', async () => {
      const { handler, response } = run(`${review}/about?ref=x%26y`, env)
      const redirect = await response
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('location')).toBe('https://best.serp.co/about/?ref=x%26y')
      expect(redirect.headers.get(WORKER_VERSION_HEADER)).toBe(version.id)
      expect(handler.serve).not.toHaveBeenCalled()
    })

    it('serves smoke-test requests through workers.dev, noindex', async () => {
      const smoke = { headers: { [SMOKE_TEST_HEADER]: '1' } }
      const slash = await run(`${review}/about`, env, smoke).response
      expect(slash.status).toBe(308)
      expect(slash.headers.get('location')).toBe('/about/')
      const { handler, response } = run(`${review}/`, env, smoke)
      const page = await response
      expect(page.status).toBe(200)
      expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(handler.serve).toHaveBeenCalledOnce()
    })

    it('never redirects best.serp.co or staging', async () => {
      expect((await run(`${production}/`, env).response).status).toBe(200)
      const stagingOn = { SITE_ENVIRONMENT: 'staging', CANONICAL_HOST_REDIRECT: 'on' }
      expect((await run(`${staging}/`, stagingOn).response).status).toBe(200)
    })
  })
})

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

/**
 * Regression for the serpcompany/best.serp.co#41 review: a client-sent `x-nonce` was rendered
 * into a page the edge cache then served to every later visitor for 24 hours. The renderer
 * here reflects request headers the way `JsonLd` reflected `x-nonce`.
 */
describe('Worker request pipeline and the edge cache', () => {
  it('never stores a request-controlled header value', async () => {
    const cache = new MemoryCache()
    const pending: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
    const rendered: Request[] = []
    const visit = async (headers: Record<string, string>) => {
      const response = await handleWorkerRequest(
        new Request(`${production}/products/?probe=1`, { headers }),
        productionEnv,
        {
          configRedirects,
          serve: request =>
            withEdgeCache(
              request,
              context,
              {
                cache: cache as unknown as Cache,
                deploymentId: version.id,
                epoch: async () => 'e'
              },
              async forwarded => {
                rendered.push(forwarded)
                const reflected = [
                  'x-nonce',
                  'x-forwarded-host',
                  'cookie',
                  'x-middleware-subrequest'
                ]
                  .map(name => `${name}=${forwarded.headers.get(name) ?? ''}`)
                  .join(';')
                return new Response(`<script nonce-probe="${reflected}"></script>`)
              }
            )
        }
      )
      await Promise.all(pending.splice(0))
      return response
    }

    const attacker = await visit({
      cookie: 'theme=ATTACKER',
      'x-forwarded-host': 'attacker.example',
      'x-middleware-subrequest': 'ATTACKER',
      'x-nonce': 'ATTACKER-NONCE'
    })
    expect(attacker.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
    expect(await attacker.text()).not.toContain('ATTACKER')
    expect(rendered[0]?.headers.get('x-nonce')).toBeNull()

    const visitor = await visit({})
    expect(visitor.headers.get(EDGE_CACHE_HEADER)).toBe('HIT')
    expect(await visitor.text()).toBe(
      '<script nonce-probe="x-nonce=;x-forwarded-host=;cookie=;x-middleware-subrequest="></script>'
    )
    expect(rendered).toHaveLength(1)
  })
})
