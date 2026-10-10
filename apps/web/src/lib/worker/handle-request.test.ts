import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { parseRobotsTxt, robotsTxtAllows } from '../../../../../scripts/crawl-policy'
import { ACCESS_JWT_HEADER } from '../auth/cloudflare-access'
import { EDGE_CACHE_HEADER, withEdgeCache } from '../edge-cache/html-cache'
import {
  NON_PRODUCTION_ROBOTS_TXT,
  SITE_ENVIRONMENT_HEADER,
  SMOKE_TEST_HEADER,
  STAGING_CANONICAL_ROBOTS_TXT,
  WORKER_VERSION_HEADER
} from '../environment/site-environment'
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
const stagingEnv: WorkerRequestEnv = {
  CANONICAL_HOST_REDIRECT: 'on',
  CF_VERSION_METADATA: version,
  SITE_ENVIRONMENT: 'staging'
}
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
    ['staging', staging, { SITE_ENVIRONMENT: 'staging' }, 'staging'],
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
    const response = await run(`${staging}/robots.txt/`, { SITE_ENVIRONMENT: 'staging' }).response
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
      expect(await robots.text()).toBe(NON_PRODUCTION_ROBOTS_TXT)
      const canonical = run(`${stagingCanonical}/`, stagingEnv)
      expect((await canonical.response).status).toBe(200)
      expect(canonical.handler.serve).toHaveBeenCalledOnce()
    })
  })
})

// #323: Ahrefs' Site Audit may crawl staging's canonical host; nothing else changes.
describe("staging's canonical host and Ahrefs' Site Audit", () => {
  const as = (userAgent: string) => ({ headers: { 'user-agent': userAgent } })

  it('serves a robots.txt that lets AhrefsSiteAudit in and keeps every other crawler out', async () => {
    for (const userAgent of [AHREFS_SITE_AUDIT, BROWSER]) {
      const { handler, response } = run(`${stagingCanonical}/robots.txt`, stagingEnv, as(userAgent))
      const robots = await response
      const text = await robots.text()
      expect(text).toBe('User-agent: AhrefsSiteAudit\nAllow: /\n\nUser-agent: *\nDisallow: /\n')
      expect(text).toBe(STAGING_CANONICAL_ROBOTS_TXT)
      expect(handler.serve).not.toHaveBeenCalled()
      const groups = parseRobotsTxt(text)
      expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/')).toBe(true)
      expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/products/autoenhance.ai/')).toBe(true)
      for (const agent of ['*', 'googlebot', 'bingbot', 'ahrefsbot'])
        expect(robotsTxtAllows(groups, agent, '/'), agent).toBe(false)
    }
  })

  it('sends AhrefsSiteAudit no X-Robots-Tag, and every other client noindex', async () => {
    for (const path of ['/', '/about/', '/sitemap-index.xml', '/robots.txt', '/about']) {
      const audit = await run(`${stagingCanonical}${path}`, stagingEnv, as(AHREFS_SITE_AUDIT))
        .response
      expect(audit.headers.get('x-robots-tag'), path).toBeNull()
      expect(audit.headers.get(SITE_ENVIRONMENT_HEADER), path).toBe('staging')
      for (const userAgent of [
        BROWSER,
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
        ''
      ]) {
        const other = await run(`${stagingCanonical}${path}`, stagingEnv, as(userAgent)).response
        expect(other.headers.get('x-robots-tag'), `${path} ${userAgent}`).toBe('noindex, nofollow')
      }
    }
    const lowercase = await run(`${stagingCanonical}/`, stagingEnv, as('ahrefssiteaudit/6.1'))
      .response
    expect(lowercase.headers.get('x-robots-tag')).toBeNull()
  })

  it("keeps a page's own noindex for AhrefsSiteAudit, as best.serp.co would", async () => {
    const response = await handleWorkerRequest(
      new Request(`${stagingCanonical}/products/?page=2`, as(AHREFS_SITE_AUDIT)),
      stagingEnv,
      {
        configRedirects,
        serve: async () =>
          new Response('page', { headers: { 'x-robots-tag': 'noindex, nofollow, noarchive' } })
      }
    )
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it.each([
    ["staging's workers.dev host (smoke test)", staging, stagingEnv, 'staging'],
    ['staging without its redirect switch', staging, { SITE_ENVIRONMENT: 'staging' }, 'staging'],
    ['the production review URL', review, productionEnv, 'production'],
    [
      'the production Worker on staging.best.serp.co',
      stagingCanonical,
      productionEnv,
      'production'
    ],
    ['the staging Worker on best.serp.co', production, stagingEnv, 'staging'],
    ['a local Worker', 'http://127.0.0.1:8787', { SITE_ENVIRONMENT: 'local' }, 'local'],
    ['a Worker without SITE_ENVIRONMENT', stagingCanonical, {}, 'unset']
  ])(
    'gives AhrefsSiteAudit nothing on %s',
    async (_label, origin, env: WorkerRequestEnv, reported) => {
      const audit = { headers: { [SMOKE_TEST_HEADER]: '1', 'user-agent': AHREFS_SITE_AUDIT } }
      const robots = await run(`${origin}/robots.txt`, env, audit).response
      expect(await robots.text()).toBe(NON_PRODUCTION_ROBOTS_TXT)
      expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const page = await run(`${origin}/`, env, audit).response
      expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(page.headers.get(SITE_ENVIRONMENT_HEADER)).toBe(reported)
    }
  )

  it('leaves public production indexable for every client, AhrefsSiteAudit included', async () => {
    for (const userAgent of [AHREFS_SITE_AUDIT, BROWSER]) {
      const robots = await run(`${production}/robots.txt`, productionEnv, as(userAgent)).response
      expect(await robots.text()).toBe('User-Agent: *\nAllow: /\n')
      expect(robots.headers.get('x-robots-tag')).toBeNull()
      const page = await run(`${production}/`, productionEnv, as(userAgent)).response
      expect(page.headers.get('x-robots-tag')).toBeNull()
    }
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

  // #323: the AhrefsSiteAudit exemption is decided per request after the cache, so a stored
  // response never carries the crawl headers, and neither order of visitors can leak them.
  it.each([
    ['AhrefsSiteAudit first', [AHREFS_SITE_AUDIT, BROWSER, AHREFS_SITE_AUDIT, BROWSER]],
    ['a visitor first', [BROWSER, AHREFS_SITE_AUDIT, BROWSER, AHREFS_SITE_AUDIT]]
  ])(
    "never serves staging's AhrefsSiteAudit exemption to anyone else from the cache (%s)",
    async (_label, visitors) => {
      const cache = new MemoryCache()
      const pending: Promise<unknown>[] = []
      const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
      const visit = async (url: string, headers: Record<string, string>) => {
        const response = await handleWorkerRequest(new Request(url, { headers }), stagingEnv, {
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
              // What OpenNext renders: next.config.ts adds its noindex on *.workers.dev only.
              async rendered =>
                new Response('<html>page</html>', {
                  headers: new URL(rendered.url).hostname.endsWith('.workers.dev')
                    ? { 'x-robots-tag': 'noindex, nofollow' }
                    : {}
                })
            )
        })
        await Promise.all(pending.splice(0))
        return response
      }

      // The workers.dev host's copy (stored by the smoke run) is a different cache entry.
      const smoke = await visit(`${staging}/products/`, { [SMOKE_TEST_HEADER]: '1' })
      expect(smoke.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const states: string[] = []
      for (const userAgent of visitors) {
        const response = await visit(`${stagingCanonical}/products/`, { 'user-agent': userAgent })
        states.push(response.headers.get(EDGE_CACHE_HEADER) ?? '')
        expect(await response.text()).toBe('<html>page</html>')
        expect(response.headers.get('x-robots-tag'), userAgent).toBe(
          userAgent === AHREFS_SITE_AUDIT ? null : 'noindex, nofollow'
        )
      }
      expect(states).toEqual(['MISS', 'HIT', 'HIT', 'HIT'])
      // Two entries, one per host; the canonical host's carries no crawl header at all.
      expect(cache.entries.size).toBe(2)
      for (const [key, stored] of cache.entries)
        expect(stored.headers.get('x-robots-tag'), key).toBe(
          key.includes('best-serp-co-staging.serpcompany.workers.dev') ? 'noindex, nofollow' : null
        )
    }
  )
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
    const stagingEnv: WorkerRequestEnv = { SITE_ENVIRONMENT: 'staging' }
    expect((await gate(`${staging}/admin/`, stagingEnv)).response.status).toBe(401)
    expect((await gate(`${staging}/ADMIN/`, stagingEnv)).response.status).toBe(401)
    expect((await gate(`${staging}/admin/`, stagingEnv, session)).serve).toHaveBeenCalledOnce()
    const flagged = await gate(
      `${staging}/admin/`,
      { CF_ACCESS_REQUIRED: 'on', SITE_ENVIRONMENT: 'staging' },
      session
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
