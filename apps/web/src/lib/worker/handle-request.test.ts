import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { parseRobotsTxt, robotsTxtAllows } from '../../../../../scripts/crawl-policy'
import { ACCESS_JWT_HEADER } from '../auth/cloudflare-access'
import { EDGE_CACHE_HEADER, withEdgeCache } from '../edge-cache/html-cache'
import {
  NON_PRODUCTION_ROBOTS_TXT,
  SITE_ENVIRONMENT_HEADER,
  SMOKE_TEST_HEADER,
  stagingRobotsTxt,
  WORKER_VERSION_HEADER
} from '../environment/site-environment'
import { STAGING_ACCESS_CHALLENGE } from '../environment/staging-access'
import { handleWorkerRequest, type WorkerRequestEnv } from './handle-request'

const production = 'https://best.serp.co'
const review = 'https://best-serp-co-production.serpcompany.workers.dev'
const staging = 'https://best-serp-co-staging.serpcompany.workers.dev'
/** Staging's canonical host (#323); `staging` above is its workers.dev host. */
const stagingCanonical = 'https://staging.best.serp.co'
/** Ahrefs' Site Audit crawler, as it identifies itself. */
const AHREFS_SITE_AUDIT =
  'Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/site-audit)'
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'
const version = { id: '9d6c0a52-1111-4222-8333-444455556666' }
/** Staging's password in these tests; the real one is in `env.staging.vars` (#359). */
const STAGING_PASSWORD = 'pipeline-test-password'
const stagingEnv: WorkerRequestEnv = {
  CANONICAL_HOST_REDIRECT: 'on',
  CF_VERSION_METADATA: version,
  SITE_ENVIRONMENT: 'staging',
  STAGING_BASIC_AUTH_PASSWORD: STAGING_PASSWORD
}
/** An `Authorization: Basic` header for `username:password`. */
function basicAuth(password: string, username = 'staging'): string {
  return `Basic ${btoa(`${username}:${password}`)}`
}
const withPassword = { authorization: basicAuth(STAGING_PASSWORD) }
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
    expect(served.headers.get(SITE_ENVIRONMENT_HEADER)).toBe('production')
    expect(handler.serve).toHaveBeenCalledOnce()
  })

  it.each([
    ['the production review URL', review, productionEnv, 'production'],
    ['a Worker without SITE_ENVIRONMENT', production, { CF_VERSION_METADATA: version }, 'unset'],
    ['a misspelled SITE_ENVIRONMENT', production, { SITE_ENVIRONMENT: 'Production' }, 'unset']
  ])('keeps %s out of indexes', async (_label, origin, env: WorkerRequestEnv, reported) => {
    const robots = run(`${origin}/robots.txt`, env)
    const answered = await robots.response
    expect(await answered.text()).toBe(NON_PRODUCTION_ROBOTS_TXT)
    expect(answered.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(robots.handler.serve).not.toHaveBeenCalled()

    for (const path of ['/', '/sitemap-index.xml', '/about']) {
      const response = await run(`${origin}${path}`, env).response
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow')
      expect(response.headers.get(SITE_ENVIRONMENT_HEADER), path).toBe(reported)
    }
  })

  it('answers the trailing-slash rule before the non-production robots.txt', async () => {
    const response = await run(`${review}/robots.txt/`, productionEnv).response
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/robots.txt')
  })

  it('sends an old root-level listing URL to its page in one hop, before the slash rule', async () => {
    const legacyRoot = vi.fn(async (request: Request) =>
      new URL(request.url).pathname.startsWith('/autoenhance.ai')
        ? new Response(null, { headers: { location: '/products/autoenhance.ai/' }, status: 308 })
        : null
    )
    for (const path of ['/autoenhance.ai', '/autoenhance.ai/']) {
      const handler = { ...pipeline(), legacyRoot }
      const redirect = await handleWorkerRequest(
        new Request(`${production}${path}`),
        productionEnv,
        handler
      )
      expect(redirect.status, path).toBe(308)
      expect(redirect.headers.get('location'), path).toBe('/products/autoenhance.ai/')
      expect(redirect.headers.get(WORKER_VERSION_HEADER), path).toBe(version.id)
      expect(handler.serve, path).not.toHaveBeenCalled()
    }
    const handler = { ...pipeline(), legacyRoot }
    const slash = await handleWorkerRequest(
      new Request(`${production}/about`),
      productionEnv,
      handler
    )
    expect(slash.headers.get('location')).toBe('/about/')
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

    it('never redirects best.serp.co, or staging to best.serp.co', async () => {
      expect((await run(`${production}/`, env).response).status).toBe(200)
      // The staging Worker's switch sends its workers.dev host to its own canonical host.
      const redirect = await run(`${staging}/`, stagingEnv).response
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('location')).toBe(`${stagingCanonical}/`)
    })
  })

  // #323: staging mirrors production's host setup on staging.best.serp.co.
  describe('on staging with CANONICAL_HOST_REDIRECT=on', () => {
    it('redirects workers.dev to staging.best.serp.co in one hop, before the slash rule and the cache', async () => {
      const { handler, response } = run(`${staging}/about?ref=x%26y`, stagingEnv)
      const redirect = await response
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('location')).toBe(`${stagingCanonical}/about/?ref=x%26y`)
      expect(redirect.headers.get(WORKER_VERSION_HEADER)).toBe(version.id)
      expect(redirect.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(handler.serve).not.toHaveBeenCalled()
    })

    it('serves smoke-test requests through workers.dev, noindex, and never redirects its canonical host', async () => {
      const smoke = { headers: { [SMOKE_TEST_HEADER]: '1' } }
      const page = run(`${staging}/`, stagingEnv, smoke)
      expect((await page.response).status).toBe(200)
      expect((await page.response).headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const robots = await run(`${staging}/robots.txt`, stagingEnv, smoke).response
      expect(await robots.text()).toBe(stagingRobotsTxt())
      // The canonical host is not redirected; it asks for the password (#359).
      const anonymous = run(`${stagingCanonical}/`, stagingEnv)
      expect((await anonymous.response).status).toBe(401)
      expect(anonymous.handler.serve).not.toHaveBeenCalled()
      const canonical = run(`${stagingCanonical}/`, stagingEnv, { headers: withPassword })
      expect((await canonical.response).status).toBe(200)
      expect(canonical.handler.serve).toHaveBeenCalledOnce()
    })
  })
})

// #359: staging sits behind HTTP Basic auth (serp standards/staging-access.md). A request that
// passes is served as best.serp.co would serve it; production and local never ask.
describe("staging's password", () => {
  const anonymousPaths = [
    '/',
    '/about/',
    '/about',
    '/products/autoenhance.ai/',
    '/products/autoenhance.ai/reviews/',
    '/autoenhance.ai/',
    '/news',
    '/sitemap-index.xml',
    '/rss.xml',
    '/robots.txt/',
    '/api/search?q=x',
    '/api/auth/get-session',
    '/admin/',
    '/api/dev/email-outbox',
    '/_next/image?url=%2Flogo.png&w=64&q=75'
  ]

  it('answers 401 with a Basic challenge to every other request without it, before anything else', async () => {
    for (const host of [stagingCanonical, `${staging}`]) {
      for (const path of anonymousPaths) {
        const legacyRoot = vi.fn(async () => null)
        const handler = { ...pipeline(), legacyRoot }
        const env =
          host === staging ? { ...stagingEnv, CANONICAL_HOST_REDIRECT: 'off' } : stagingEnv
        for (const method of ['GET', 'HEAD', 'POST']) {
          const response = await handleWorkerRequest(
            new Request(`${host}${path}`, { method }),
            env,
            handler
          )
          const label = `${method} ${host}${path}`
          expect(response.status, label).toBe(401)
          expect(response.headers.get('www-authenticate'), label).toBe(STAGING_ACCESS_CHALLENGE)
          expect(response.headers.get('cache-control'), label).toBe('no-store')
          expect(response.headers.get('x-robots-tag'), label).toBe('noindex, nofollow')
          expect(response.headers.get(SITE_ENVIRONMENT_HEADER), label).toBe('staging')
          expect(response.headers.get(WORKER_VERSION_HEADER), label).toBe(version.id)
        }
        expect(handler.serve, path).not.toHaveBeenCalled()
        expect(legacyRoot, path).not.toHaveBeenCalled()
      }
    }
  })

  it('refuses a wrong or malformed password, and every password without the var', async () => {
    for (const authorization of [
      basicAuth('wrong'),
      basicAuth(''),
      basicAuth(STAGING_PASSWORD.toUpperCase()),
      `Bearer ${STAGING_PASSWORD}`,
      `Basic ${STAGING_PASSWORD}`
    ]) {
      const response = await run(`${stagingCanonical}/`, stagingEnv, { headers: { authorization } })
        .response
      expect(response.status, authorization).toBe(401)
    }
    for (const env of [
      { ...stagingEnv, STAGING_BASIC_AUTH_PASSWORD: undefined },
      { ...stagingEnv, STAGING_BASIC_AUTH_PASSWORD: '' }
    ]) {
      for (const authorization of [basicAuth(STAGING_PASSWORD), basicAuth('')]) {
        const { handler, response } = run(`${stagingCanonical}/`, env, {
          headers: { authorization }
        })
        expect((await response).status).toBe(401)
        expect(handler.serve).not.toHaveBeenCalled()
      }
      // The exemptions still answer.
      expect((await run(`${stagingCanonical}/robots.txt`, env).response).status).toBe(200)
    }
  })

  it('serves a request with the password as best.serp.co would: no environment noindex', async () => {
    for (const username of ['staging', '', 'ahrefs']) {
      const { handler, response } = run(`${stagingCanonical}/about/`, stagingEnv, {
        headers: { authorization: basicAuth(STAGING_PASSWORD, username), 'user-agent': BROWSER }
      })
      const page = await response
      expect(page.status, username).toBe(200)
      expect(page.headers.get('x-robots-tag'), username).toBeNull()
      expect(page.headers.get('www-authenticate'), username).toBeNull()
      expect(page.headers.get(SITE_ENVIRONMENT_HEADER)).toBe('staging')
      // The password goes no further than the gate: the rest of the pipeline never sees it.
      const served = handler.serve.mock.calls[0]?.[0]
      expect(served?.headers.has('authorization')).toBe(false)
      expect(served?.headers.get('user-agent')).toBe(BROWSER)
    }
    // The pipeline's own answers follow the gate, without the noindex either.
    const slash = await run(`${stagingCanonical}/about?x=1`, stagingEnv, { headers: withPassword })
      .response
    expect(slash.status).toBe(308)
    expect(slash.headers.get('location')).toBe('/about/?x=1')
    expect(slash.headers.get('x-robots-tag')).toBeNull()
    const gone = await run(`${stagingCanonical}/news`, stagingEnv, { headers: withPassword })
      .response
    expect(gone.status).toBe(410)
    expect(gone.headers.get('x-robots-tag')).toBeNull()
  })

  it("keeps a page's own noindex for a request with the password, as best.serp.co would", async () => {
    const response = await handleWorkerRequest(
      new Request(`${stagingCanonical}/products/?page=2`, { headers: withPassword }),
      stagingEnv,
      {
        configRedirects,
        serve: async () =>
          new Response('page', { headers: { 'x-robots-tag': 'noindex, nofollow, noarchive' } })
      }
    )
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it('serves robots.txt without the password, disallowing all but the auditor', async () => {
    for (const headers of [{}, withPassword, { [SMOKE_TEST_HEADER]: '1' }]) {
      for (const host of [stagingCanonical, staging]) {
        // Staging's workers.dev host answers only smoke-test requests; the rest get the 308.
        const sent = host === staging ? { ...headers, [SMOKE_TEST_HEADER]: '1' } : headers
        const { handler, response } = run(`${host}/robots.txt`, stagingEnv, { headers: sent })
        const robots = await response
        expect(robots.status).toBe(200)
        const text = await robots.text()
        expect(text).toBe(stagingRobotsTxt())
        expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow')
        expect(handler.serve).not.toHaveBeenCalled()
        const groups = parseRobotsTxt(text)
        expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/')).toBe(true)
        expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/products/autoenhance.ai/')).toBe(true)
        expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/search/')).toBe(false)
        for (const agent of ['*', 'googlebot', 'bingbot', 'ahrefsbot'])
          expect(robotsTxtAllows(groups, agent, '/'), agent).toBe(false)
      }
    }
  })

  it('serves smoke-test requests without the password, noindex', async () => {
    for (const host of [stagingCanonical, staging]) {
      for (const headers of [
        { [SMOKE_TEST_HEADER]: '1' },
        { [SMOKE_TEST_HEADER]: '1', ...withPassword }
      ]) {
        const { handler, response } = run(`${host}/about/`, stagingEnv, { headers })
        const page = await response
        expect(page.status, host).toBe(200)
        expect(page.headers.get('x-robots-tag'), host).toBe('noindex, nofollow')
        expect(handler.serve).toHaveBeenCalledOnce()
      }
    }
  })

  it('lets the billing webhook through without the password, noindex', async () => {
    for (const path of ['/api/billing/webhook/', '/api/billing/webhook']) {
      const { handler, response } = run(`${stagingCanonical}${path}`, stagingEnv, {
        body: '{}',
        headers: { 'x-webhook-signature': 't=1,v1=x' },
        method: 'POST'
      })
      const answer = await response
      expect(answer.status, path).toBe(200)
      expect(answer.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const served = handler.serve.mock.calls[0]?.[0]
      expect(served?.headers.get('x-webhook-signature')).toBe('t=1,v1=x')
      expect(await served?.text()).toBe('{}')
    }
    const get = await run(`${stagingCanonical}/api/billing/webhook/`, stagingEnv).response
    expect(get.status).toBe(401)
  })

  it.each([
    ['public production', production, productionEnv, 'production'],
    ['the production review URL', review, productionEnv, 'production'],
    [
      'the production Worker on staging.best.serp.co',
      stagingCanonical,
      productionEnv,
      'production'
    ],
    [
      'the production Worker, even with a password var',
      production,
      { ...productionEnv, STAGING_BASIC_AUTH_PASSWORD: STAGING_PASSWORD },
      'production'
    ],
    ['a local Worker', 'http://127.0.0.1:8787', { SITE_ENVIRONMENT: 'local' }, 'local'],
    [
      'a local Worker with the e2e switch but not local D1',
      'http://127.0.0.1:8787',
      { LOCAL_STAGING_ACCESS: 'on', SITE_ENVIRONMENT: 'local' },
      'local'
    ],
    ['a Worker without SITE_ENVIRONMENT', stagingCanonical, {}, 'unset']
  ])(
    'never asks for a password on %s, and passes Authorization on as today',
    async (_label, origin, env: WorkerRequestEnv, reported) => {
      for (const headers of [{}, { authorization: basicAuth('anything') }]) {
        const { handler, response } = run(`${origin}/`, env, { headers })
        const page = await response
        expect(page.status).toBe(200)
        expect(page.headers.get('www-authenticate')).toBeNull()
        expect(page.headers.get(SITE_ENVIRONMENT_HEADER)).toBe(reported)
        expect(handler.serve.mock.calls[0]?.[0].headers.get('authorization') ?? null).toBe(
          headers.authorization ?? null
        )
      }
      const robots = await run(`${origin}/robots.txt`, env).response
      if (origin === production) {
        expect(await robots.text()).toBe('User-Agent: *\nAllow: /\n')
        expect(robots.headers.get('x-robots-tag')).toBeNull()
      } else {
        expect(await robots.text()).toBe(NON_PRODUCTION_ROBOTS_TXT)
        expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      }
    }
  )

  it('leaves public production indexable for every client, with or without a password', async () => {
    for (const headers of [{}, withPassword, { 'user-agent': AHREFS_SITE_AUDIT }]) {
      const robots = await run(`${production}/robots.txt`, productionEnv, { headers }).response
      expect(await robots.text()).toBe('User-Agent: *\nAllow: /\n')
      expect(robots.headers.get('x-robots-tag')).toBeNull()
      const page = await run(`${production}/`, productionEnv, { headers }).response
      expect(page.status).toBe(200)
      expect(page.headers.get('x-robots-tag')).toBeNull()
    }
  })

  it('gives AhrefsSiteAudit no exemption by its user agent any more (#323 is replaced)', async () => {
    const audit = await run(`${stagingCanonical}/`, stagingEnv, {
      headers: { 'user-agent': AHREFS_SITE_AUDIT }
    }).response
    expect(audit.status).toBe(401)
    const smoke = await run(`${staging}/`, stagingEnv, {
      headers: { [SMOKE_TEST_HEADER]: '1', 'user-agent': AHREFS_SITE_AUDIT }
    }).response
    expect(smoke.headers.get('x-robots-tag')).toBe('noindex, nofollow')
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

  // #359: the password is checked before the cache and the noindex added after it, so a page
  // stored for a request with the password never reaches one without it, a 401 is never
  // stored, and a smoke-test request still gets the noindex from the same entry.
  function stagingWorker() {
    const cache = new MemoryCache()
    const pending: Promise<unknown>[] = []
    const rendered: Request[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
    const visit = async (url: string, headers: Record<string, string> = {}) => {
      const response = await handleWorkerRequest(new Request(url, { headers }), stagingEnv, {
        configRedirects,
        serve: request =>
          withEdgeCache(
            request,
            context,
            { cache: cache as unknown as Cache, deploymentId: version.id, epoch: async () => 'e' },
            async forwarded => {
              rendered.push(forwarded)
              // What OpenNext renders: the same page whichever side of the gate asked.
              return new Response('<html>page</html>', {
                headers: { 'content-type': 'text/html; charset=utf-8' }
              })
            }
          )
      })
      await Promise.all(pending.splice(0))
      return response
    }
    return { cache, rendered, visit }
  }

  it.each([
    ['the password first', ['password', 'anonymous', 'smoke', 'anonymous', 'password']],
    ['an anonymous request first', ['anonymous', 'password', 'anonymous', 'smoke', 'password']],
    ['a smoke-test request first', ['smoke', 'anonymous', 'password', 'anonymous', 'smoke']]
  ] as const)(
    'never serves a stored staging page across the password (%s)',
    async (_label, visitors) => {
      const { cache, rendered, visit } = stagingWorker()
      const states: string[] = []
      for (const visitor of visitors) {
        const headers =
          visitor === 'password'
            ? withPassword
            : visitor === 'smoke'
              ? { [SMOKE_TEST_HEADER]: '1' }
              : {}
        const response = await visit(`${stagingCanonical}/products/`, headers)
        const body = await response.text()
        if (visitor === 'anonymous') {
          expect(response.status).toBe(401)
          expect(body).not.toContain('page')
          expect(response.headers.get(EDGE_CACHE_HEADER)).toBeNull()
          continue
        }
        expect(response.status, visitor).toBe(200)
        expect(body).toBe('<html>page</html>')
        states.push(response.headers.get(EDGE_CACHE_HEADER) ?? '')
        expect(response.headers.get('x-robots-tag'), visitor).toBe(
          visitor === 'password' ? null : 'noindex, nofollow'
        )
      }
      // One render, then hits: a request with the password is cached like an anonymous one.
      expect(states[0]).toBe('MISS')
      expect(states.slice(1).every(state => state === 'HIT')).toBe(true)
      expect(rendered).toHaveLength(1)
      expect(rendered[0]?.headers.has('authorization')).toBe(false)
      // One entry, with no 401, no crawl header and no challenge in it.
      expect(cache.entries.size).toBe(1)
      for (const stored of cache.entries.values()) {
        expect(stored.status).toBe(200)
        expect(stored.headers.get('x-robots-tag')).toBeNull()
        expect(stored.headers.get('www-authenticate')).toBeNull()
      }
    }
  )

  it('never stores a 401, so the password still gets the page right after one', async () => {
    const { cache, visit } = stagingWorker()
    for (let attempt = 0; attempt < 3; attempt++) {
      const refused = await visit(`${stagingCanonical}/about/`)
      expect(refused.status).toBe(401)
      expect(refused.headers.get('cache-control')).toBe('no-store')
    }
    expect(cache.entries.size).toBe(0)
    const page = await visit(`${stagingCanonical}/about/`, withPassword)
    expect(page.status).toBe(200)
    expect(page.headers.get(EDGE_CACHE_HEADER)).toBe('MISS')
  })

  it("keeps the password out of a bypassed request's render too", async () => {
    const { rendered, visit } = stagingWorker()
    const response = await visit(`${stagingCanonical}/search/?q=x`, withPassword)
    expect(response.headers.get(EDGE_CACHE_HEADER)).toBe('BYPASS')
    expect(rendered[0]?.headers.has('authorization')).toBe(false)
  })
})

// serpcompany/best.serp.co#60: /admin and /api/admin need Cloudflare Access (production) and a
// Better Auth session; the pages and handlers then require an admin.
describe('admin gate', () => {
  const team = 'serpcompany.cloudflareaccess.com'
  const aud = 'c'.repeat(64)
  const accessEnv: WorkerRequestEnv = {
    ...productionEnv,
    CF_ACCESS_AUD: aud,
    CF_ACCESS_TEAM_DOMAIN: team
  }
  const session = { cookie: '__Secure-better-auth.session_token=token.signature' }

  async function accessFixture() {
    const pair = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k' }] }
    const jwt = await new SignJWT({ email: 'devin@serp.co' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(`https://${team}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey)
    return { getKey: () => createLocalJWKSet(jwks), jwt }
  }

  async function gate(url: string, env: WorkerRequestEnv, headers: Record<string, string> = {}) {
    const { getKey, jwt } = await accessFixture()
    const handler = pipeline()
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, value === 'VALID_JWT' ? jwt : value])
    )
    const response = await handleWorkerRequest(new Request(url, { headers: resolved }), env, {
      ...handler,
      access: { getKey }
    })
    return { response, serve: handler.serve }
  }

  it('answers 503 in production until the Access vars are configured', async () => {
    for (const path of ['/admin/', '/api/admin/listings', '/admin/submissions/1/']) {
      const { response, serve } = await gate(`${production}${path}`, productionEnv, {
        ...session,
        [ACCESS_JWT_HEADER]: 'VALID_JWT'
      })
      expect(response.status, path).toBe(503)
      expect(await response.text()).toBe('Access not configured\n')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(serve).not.toHaveBeenCalled()
    }
  })

  it('answers 403 in production without a valid Access JWT, even with a session', async () => {
    for (const headers of [session, { ...session, [ACCESS_JWT_HEADER]: 'forged.token.value' }]) {
      const { response, serve } = await gate(`${production}/admin/`, accessEnv, headers)
      expect(response.status).toBe(403)
      expect(serve).not.toHaveBeenCalled()
    }
  })

  it('answers 401 to an Access-verified request without a session cookie', async () => {
    const { response, serve } = await gate(`${production}/api/admin/anything`, accessEnv, {
      [ACCESS_JWT_HEADER]: 'VALID_JWT',
      cookie: 'theme=dark'
    })
    expect(response.status).toBe(401)
    expect(serve).not.toHaveBeenCalled()
  })

  it('passes Access plus a session cookie on to the admin pages, which check the role', async () => {
    const { response, serve } = await gate(`${production}/admin/`, accessEnv, {
      ...session,
      [ACCESS_JWT_HEADER]: 'VALID_JWT'
    })
    expect(response.status).toBe(200)
    expect(serve).toHaveBeenCalledOnce()
  })

  it('needs only the session cookie on staging and locally unless Access is switched on', async () => {
    // Behind staging's password (#359), which the admin gate never sees.
    const stagingEnv: WorkerRequestEnv = {
      SITE_ENVIRONMENT: 'staging',
      STAGING_BASIC_AUTH_PASSWORD: STAGING_PASSWORD
    }
    for (const path of ['/admin/', '/ADMIN/']) {
      const { response } = await gate(`${staging}${path}`, stagingEnv, withPassword)
      expect(response.status, path).toBe(401)
      expect(response.headers.get('www-authenticate'), path).toBeNull()
    }
    expect(
      (await gate(`${staging}/admin/`, stagingEnv, { ...withPassword, ...session })).serve
    ).toHaveBeenCalledOnce()
    const flagged = await gate(
      `${staging}/admin/`,
      { ...stagingEnv, CF_ACCESS_REQUIRED: 'on' },
      { ...withPassword, ...session }
    )
    expect(flagged.response.status).toBe(503)
    const local = await gate('http://localhost:8787/api/admin/x', { SITE_ENVIRONMENT: 'local' })
    expect(local.response.status).toBe(401)
  })

  it('treats a Worker without SITE_ENVIRONMENT as production', async () => {
    const { response } = await gate(`${production}/admin/`, {}, session)
    expect(response.status).toBe(503)
  })

  it('leaves every other path alone', async () => {
    for (const path of ['/', '/about/', '/api/auth/get-session', '/administrator/']) {
      const { response, serve } = await gate(`${production}${path}`, productionEnv)
      expect(response.status, path).toBe(200)
      expect(serve, path).toHaveBeenCalledOnce()
    }
  })
})

describe('retired paths (#166)', () => {
  it.each(['/news', '/news/'])('answers %s 410 before the slash rule and the cache', async path => {
    const { handler, response } = run(`${production}${path}`, productionEnv)
    const served = await response
    expect(served.status).toBe(410)
    expect(served.headers.get('location')).toBeNull()
    expect(handler.serve).not.toHaveBeenCalled()
  })
})

describe('local dev endpoints (#164)', () => {
  const devPaths = ['/api/dev/email-outbox?to=a%40example.com', '/api/auth/dev/otp-outbox?email=a']

  it.each(devPaths)(
    'answers %s with 404 on a deployed host, whatever the headers say',
    async path => {
      for (const origin of [production, review, staging]) {
        const { handler, response } = run(`${origin}${path}`, productionEnv, {
          // Inside OpenNext this header becomes Host; the Worker must not trust it.
          headers: { host: 'localhost', 'x-forwarded-host': 'localhost' }
        })
        expect((await response).status, origin).toBe(404)
        expect(handler.serve).not.toHaveBeenCalled()
      }
    }
  )

  // The case #164 guards against: a deploy that ran with the local config.
  it.each(devPaths)(
    'answers %s with 404 on a deployed host even with the local vars',
    async path => {
      const { handler, response } = run(`${production}${path}`, {
        ...productionEnv,
        D1_RUNTIME_ENV: 'local',
        SITE_ENVIRONMENT: 'local'
      })
      expect((await response).status).toBe(404)
      expect(handler.serve).not.toHaveBeenCalled()
    }
  )

  it.each(devPaths)('serves %s on a local host', async path => {
    const { handler, response } = run(`http://127.0.0.1:3100${path}`, {
      ...productionEnv,
      SITE_ENVIRONMENT: 'local'
    })
    expect((await response).status).toBe(200)
    expect(handler.serve).toHaveBeenCalledTimes(1)
  })
})
