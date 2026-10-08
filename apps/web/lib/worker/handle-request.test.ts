import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { ACCESS_JWT_HEADER } from '../auth/cloudflare-access'
import { EDGE_CACHE_HEADER, withEdgeCache } from '../edge-cache/html-cache'
import {
  NON_PRODUCTION_ROBOTS_TXT,
  SITE_ENVIRONMENT_HEADER,
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
