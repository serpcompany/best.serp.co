import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import type { AccessEnv } from '../apps/web/src/lib/auth/cloudflare-access'
import { accessConfig } from '../apps/web/src/lib/auth/cloudflare-access'
import {
  SITE_ENVIRONMENT_HEADER,
  SMOKE_TEST_HEADER,
  WORKER_VERSION_HEADER
} from '../apps/web/src/lib/environment/site-environment'
import {
  metaRobotsBlocksIndexing,
  robotsTxtBlockedPath,
  xRobotsTagBlocksIndexing
} from './crawl-policy.ts'
import {
  adminLockStatusesFromConfig,
  allowedAdminLockStatuses,
  canonicalHostRedirectConfigured,
  deployedWorkerVersion,
  expectedAdminLockStatus,
  expectedWorkerVersionFromEnvironment,
  type GateClock,
  type HttpGateOptions,
  httpGateSamples,
  retiredCategorySlugs,
  runHttpGates,
  waitForWorkerVersion
} from './d1-preview-http-gates.ts'

afterEach(() => vi.unstubAllGlobals())

const origin = 'https://best.serp.co'
/** Production gates go through the production Worker's platform host, never best.serp.co. */
const platformOrigin = 'https://best-serp-co-production.serpcompany.workers.dev'
const stagingOrigin = 'https://best-serp-co-staging.example.test'
/** Staging's canonical host (#323) and the platform host its gates go through. */
const stagingCanonicalOrigin = 'https://staging.best.serp.co'
const stagingPlatformOrigin = 'https://best-serp-co-staging.serpcompany.workers.dev'
const slug = 'example-product'
const category = 'seo-tools'
const samples = { categories: [category], listing: slug }
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-http-gates-'))
// Production gates, and staging gates on staging's platform host, read CANONICAL_HOST_REDIRECT
// from wrangler.jsonc. These tests pin both to `off` unless they pass their own config, so they
// don't depend on the checked-in values.
const switchOffConfigPath = join(fixtureDirectory, 'wrangler-switch-off.jsonc')
writeFileSync(
  switchOffConfigPath,
  JSON.stringify({
    env: {
      production: { vars: { CANONICAL_HOST_REDIRECT: 'off' } },
      staging: { vars: { CANONICAL_HOST_REDIRECT: 'off' } }
    }
  })
)

// The reviewed manifests the gates read for retired categories (#260): none by default, so the
// tests never read d1/publications, where d1-remote-publisher.test.ts writes temporary ones.
const noPublications = join(fixtureDirectory, 'no-publications')
mkdirSync(noPublications)

afterAll(() => rmSync(fixtureDirectory, { force: true, recursive: true }))

function gates(
  mode: string,
  baseUrl: string,
  timeoutMs?: number,
  options: HttpGateOptions = {}
): Promise<void> {
  return runHttpGates(mode, baseUrl, {
    publicationsDirectory: noPublications,
    samples,
    timeoutMs,
    wranglerConfigPath: switchOffConfigPath,
    ...options
  })
}

/** Requests the trailing-slash gates make, and the canonical redirects they require. */
const trailingSlashGatePaths = ['/about', '/robots.txt/', '/api/search/']
const canonicalRedirects: Record<string, string> = {
  '/about': '/about/',
  '/robots.txt/': '/robots.txt'
}

/** Requests the admin-lock gate makes; anonymous, so never answered with an admin page. */
const adminLockGatePaths = ['/admin/', '/api/admin']

function adminLockResponse(url: URL): Response {
  // Staging has no Access lock (401 without a session); production answers 503 until its
  // Access vars are set.
  return url.hostname.startsWith('best-serp-co-staging.')
    ? new Response('Unauthorized\n', { status: 401 })
    : new Response('Access not configured\n', { status: 503 })
}

/** The sign-in request the auth gate sends on purpose with an empty email. */
const badSignInPath = '/api/auth/email-otp/send-verification-otp'
/** Requests the Better Auth gate makes: the session read, then the bad sign-in. */
const authGatePaths = ['/api/auth/get-session', badSignInPath]

function successfulResponse(url: URL, redirectLocation?: string, emptyBody = false): Response {
  if (adminLockGatePaths.includes(url.pathname)) return adminLockResponse(url)
  if (url.pathname === badSignInPath)
    return new Response('{"code":"INVALID_EMAIL"}', { status: 400 })
  const canonical = canonicalRedirects[url.pathname]
  if (canonical) return new Response(null, { status: 308, headers: { location: canonical } })
  if (url.pathname === `/${slug}/`)
    return new Response(null, {
      status: 308,
      headers: { location: redirectLocation ?? `/products/${slug}/` }
    })
  return new Response(emptyBody ? '' : 'ok', { status: 200 })
}

function installSuccessfulFetch(redirectLocation?: string, emptyBody = false) {
  const urls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      urls.push(url)
      return withCrawlPolicy(url, successfulResponse(url, redirectLocation, emptyBody))
    })
  )
  return urls
}

describe('environment-specific HTTP gates', () => {
  it.each([origin, platformOrigin])(
    'gates Production given %s through its platform host, then best.serp.co',
    async given => {
      const urls = installSuccessfulFetch()
      await expect(gates('production', given)).resolves.toBeUndefined()
      expect(urls).toHaveLength(
        8 +
          trailingSlashGatePaths.length +
          adminLockGatePaths.length +
          authGatePaths.length +
          CRAWL_POLICY_REQUESTS.production
      )
      // Routes and versions go through the platform host; only the public policy probes, last,
      // ask best.serp.co itself.
      const publicProbes = urls.splice(-PUBLIC_POLICY_PATHS.length)
      expect(publicProbes.map(url => url.href)).toEqual(
        PUBLIC_POLICY_PATHS.map(path => `${origin}${path}`)
      )
      expect(urls.every(url => url.origin === platformOrigin)).toBe(true)
      expect(urls.map(url => url.pathname)).toEqual(
        expect.arrayContaining([
          '/',
          `/products/categories/${category}/`,
          `/products/${slug}/`,
          '/api/search',
          '/rss.xml',
          '/sitemap-index.xml',
          `/${slug}/`,
          '/submit/',
          '/admin/',
          '/api/admin',
          ...authGatePaths
        ])
      )
      expect(urls.some(url => url.pathname === '/api/search' && url.search.startsWith('?q='))).toBe(
        true
      )
    }
  )

  it('never samples a category a reviewed manifest retires (#260)', async () => {
    const publications = join(fixtureDirectory, 'publications')
    mkdirSync(publications, { recursive: true })
    writeFileSync(
      join(publications, 'retire.yaml'),
      stringify({ operations: [{ action: 'category-unpublish', slug: 'adult' }] })
    )
    const urls = installSuccessfulFetch()
    await gates('staging', stagingOrigin, undefined, {
      publicationsDirectory: publications,
      samples: { categories: ['adult', category], listing: slug }
    })
    const paths = urls.map(url => url.pathname)
    expect(paths).toContain(`/products/categories/${category}/`)
    expect(paths).not.toContain('/products/categories/adult/')
    expect(retiredCategorySlugs(publications)).toEqual(new Set(['adult']))
    await expect(
      gates('staging', stagingOrigin, undefined, {
        publicationsDirectory: publications,
        samples: { categories: ['adult'], listing: slug }
      })
    ).rejects.toThrow('add a live one to httpGateSamples')
  })

  it('samples a listing and a category no committed manifest takes off the site (#315)', () => {
    // Committed manifests only: d1-remote-publisher.test.ts writes temporary ones here.
    const committed = execFileSync('git', ['ls-files', 'd1/publications'], { encoding: 'utf8' })
      .split('\n')
      .filter(path => /\.ya?ml$/u.test(path))
    expect(committed.length).toBeGreaterThan(0)
    const retired = new Set<string>()
    const gone = new Set<string>()
    for (const path of committed) {
      const manifest = parse(readFileSync(resolve(path), 'utf8')) as {
        operations?: Array<{ action?: string; from?: string; slug?: string }>
      }
      for (const operation of manifest.operations ?? []) {
        if (operation.action === 'category-unpublish' && operation.slug) retired.add(operation.slug)
        if (operation.action === 'listing-unpublish' && operation.slug) gone.add(operation.slug)
        if (operation.action === 'listing-slug-change' && operation.from) gone.add(operation.from)
      }
    }
    expect(gone.has(httpGateSamples.listing), httpGateSamples.listing).toBe(false)
    expect(httpGateSamples.categories.filter(slug => !retired.has(slug))).not.toEqual([])
  })

  it('keeps Staging isolated from the Production hostname', async () => {
    installSuccessfulFetch()
    await expect(gates('staging', stagingOrigin)).resolves.toBeUndefined()
    await expect(gates('staging', origin)).rejects.toThrow('reject the Production hostname')
    await expect(gates('production', stagingOrigin)).rejects.toThrow(
      `require https://best.serp.co or ${platformOrigin}`
    )
    await expect(gates('public', platformOrigin)).rejects.toThrow(
      'public check requires the exact https://best.serp.co origin'
    )
  })

  it.each(['http:', 'port', 'credentials', 'path', 'query', 'hash'])(
    'rejects unsafe Production origin component %s',
    async variant => {
      const baseUrl =
        variant === 'http:'
          ? 'http://best.serp.co'
          : variant === 'port'
            ? 'https://best.serp.co:8443'
            : variant === 'credentials'
              ? 'https://user:pass@best.serp.co'
              : variant === 'path'
                ? `${origin}/path`
                : variant === 'query'
                  ? `${origin}/?query=1`
                  : `${origin}/#hash`
      await expect(gates('production', baseUrl)).rejects.toThrow('clean HTTPS origin')
    }
  )

  it('requires nonempty bodies and successful statuses', async () => {
    installSuccessfulFetch(undefined, true)
    await expect(gates('production', origin)).rejects.toThrow('no content')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input))
        if (url.pathname === '/rss.xml') return new Response('failed', { status: 500 })
        return successfulResponse(url)
      })
    )
    await expect(gates('production', origin)).rejects.toThrow('returned 500')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 }))
    )
    await expect(gates('production', origin)).rejects.toThrow('not a redirect')
  })

  it.each(['other-origin', 'wrong-path', 'query', 'hash'])(
    'rejects redirect mismatch %s',
    async variant => {
      const location =
        variant === 'other-origin'
          ? `https://other-host.example/products/${slug}/`
          : variant === 'wrong-path'
            ? `/products/${slug}/reviews/`
            : variant === 'query'
              ? `/products/${slug}/?unexpected=1`
              : `/products/${slug}/#unexpected`
      installSuccessfulFetch(location)
      await expect(gates('production', origin)).rejects.toThrow('did not redirect')
    }
  )

  it('rejects unknown modes before making requests', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(gates('preview', origin)).rejects.toThrow('exactly staging, production, or public')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('aborts requests that do not complete within the protected deadline', async () => {
    const aborted = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted()
              reject(new DOMException('aborted', 'AbortError'))
            })
          })
      )
    )
    await expect(gates('production', origin, 5)).rejects.toThrow('bounded deadline')
    expect(aborted).toHaveBeenCalled()
  })

  it('checks the trailing-slash standard on page, file, and /api URLs', async () => {
    const urls = installSuccessfulFetch()
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(urls.map(url => url.pathname)).toEqual(expect.arrayContaining(trailingSlashGatePaths))
    expect(urls.some(url => url.pathname === '/api/search/' && url.search.startsWith('?q='))).toBe(
      true
    )
  })

  it.each([
    ['/about', { location: '/about/', status: 301 }],
    ['/about', { location: '/about', status: 308 }],
    ['/about', { location: 'https://other.example/about/', status: 308 }],
    ['/robots.txt/', { location: '/robots.txt/', status: 308 }],
    ['/robots.txt/', { location: '', status: 200 }],
    ['/api/search/', { location: '/api/search', status: 308 }]
  ])('rejects %s answering %o', async (path, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input))
        if (url.pathname !== path) return successfulResponse(url)
        return new Response(null, {
          status: answer.status,
          headers: answer.location ? { location: answer.location } : {}
        })
      })
    )
    await expect(gates('production', origin)).rejects.toThrow(path)
  })
})

// Crawl and analytics policy (serp standards/environment-configuration.md). Kept apart from the
// route contracts above: after them, Staging and Production (through its platform host) fetch
// /, /sitemap-index.xml, /robots.txt, a listing page, and / without the smoke header;
// Production then fetches /, /sitemap-index.xml and /robots.txt on best.serp.co, which is all
// the manual public check does.
const PUBLIC_POLICY_PATHS = ['/', '/sitemap-index.xml', '/robots.txt']
const CRAWL_POLICY_REQUESTS = { production: 5 + 3, public: 3, staging: 5 } as const

function correctRobotsTxt(robotsOrigin: string): string {
  if (robotsOrigin !== origin) return 'User-agent: *\nDisallow: /\n'
  return `User-Agent: *\nAllow: /\nDisallow: /search\nSitemap: ${robotsOrigin}/sitemap-index.xml\n`
}

const googleTagManager =
  '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-TEST"></iframe></noscript>'

/**
 * What a correct deployment serves: workers.dev hosts are noindex everywhere, disallow
 * crawling, and load no Google Tag Manager; best.serp.co lists its sitemap and loads Google Tag
 * Manager. Every Worker response reports its SITE_ENVIRONMENT.
 */
function withCrawlPolicy(url: URL, response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set(
    SITE_ENVIRONMENT_HEADER,
    url.origin === stagingOrigin || url.origin === stagingPlatformOrigin ? 'staging' : 'production'
  )
  if (url.origin !== origin) headers.set('x-robots-tag', 'noindex, nofollow')
  if (url.pathname === '/robots.txt')
    return new Response(correctRobotsTxt(url.origin), { status: 200, headers })
  if (url.pathname === '/')
    return new Response(
      `<html><head><title>SERP</title><meta name="robots" content="index, follow"/></head><body>${url.origin === origin ? googleTagManager : ''}ok</body></html>`,
      { status: response.status, headers }
    )
  return new Response(response.body, { status: response.status, headers })
}

function stubCrawlPolicy(
  change: (url: URL, response: Response) => Response | Promise<Response>
): URL[] {
  const urls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      urls.push(url)
      return change(url, withCrawlPolicy(url, successfulResponse(url)))
    })
  )
  return urls
}

function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers)
  headers.set(name, value)
  return new Response(response.body, { headers, status: response.status })
}

describe('environment-specific crawl policy gates', () => {
  it('reads the crawl policy after the route contracts', async () => {
    const production = stubCrawlPolicy((_url, response) => response)
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(production.slice(-CRAWL_POLICY_REQUESTS.production).map(url => url.href)).toEqual([
      `${platformOrigin}/`,
      `${platformOrigin}/sitemap-index.xml`,
      `${platformOrigin}/robots.txt`,
      `${platformOrigin}/products/${slug}/`,
      `${platformOrigin}/`,
      `${origin}/`,
      `${origin}/sitemap-index.xml`,
      `${origin}/robots.txt`
    ])
    const publicSite = stubCrawlPolicy((_url, response) => response)
    await expect(gates('public', origin)).resolves.toBeUndefined()
    expect(publicSite.map(url => url.href)).toEqual([
      `${origin}/`,
      `${origin}/sitemap-index.xml`,
      `${origin}/robots.txt`
    ])
    const staging = stubCrawlPolicy((_url, response) => response)
    await expect(gates('staging', stagingOrigin)).resolves.toBeUndefined()
    expect(staging.slice(-CRAWL_POLICY_REQUESTS.staging).map(url => url.pathname)).toEqual([
      '/',
      '/sitemap-index.xml',
      '/robots.txt',
      `/products/${slug}/`,
      '/'
    ])
  })

  // PR #47 review round 3: page markup is host-independent, so a robots meta noindex on `/` or
  // a listing is caught on the workers.dev pass even when best.serp.co meets zone protection.
  it.each([
    ['/', 'production'],
    [`/products/${slug}/`, 'production'],
    ['/', 'staging']
  ])('rejects a robots meta noindex on %s in %s gates', async (path, mode) => {
    stubCrawlPolicy((url, response) =>
      url.origin !== origin && url.pathname === path
        ? new Response('<html><head><meta name="robots" content="noindex"></head></html>', {
            headers: response.headers
          })
        : response
    )
    await expect(gates(mode, mode === 'staging' ? stagingOrigin : origin)).rejects.toThrow(
      `${mode} route ${path} sent noindex in its robots meta, on every host`
    )
  })

  it.each(['/', '/sitemap-index.xml', '/robots.txt'])(
    'requires Staging to send an X-Robots-Tag noindex on %s',
    async path => {
      stubCrawlPolicy((url, response) => {
        if (url.pathname !== path) return response
        const headers = new Headers(response.headers)
        headers.delete('x-robots-tag')
        // A robots meta alone is not enough: every response carries the header.
        return new Response(
          path === '/' ? '<html><head><meta name="robots" content="noindex"></head></html>' : 'x',
          { headers }
        )
      })
      await expect(gates('staging', stagingOrigin)).rejects.toThrow(
        `staging route ${path} sent no noindex in its X-Robots-Tag header`
      )
    }
  )

  it.each([
    [
      'the production rules',
      `User-Agent: *\nAllow: /\nSitemap: ${origin}/sitemap-index.xml\n`,
      '*'
    ],
    [
      'Googlebot allowed',
      'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n',
      'googlebot'
    ],
    ['no rules', '', '*']
  ])('rejects a Staging robots.txt with %s', async (_label, robots, agent) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/robots.txt'
        ? new Response(robots, { headers: { 'x-robots-tag': 'noindex' } })
        : response
    )
    await expect(gates('staging', stagingOrigin)).rejects.toThrow(
      `staging robots.txt lets user-agent ${agent} crawl /`
    )
  })

  it('rejects Google Tag Manager on workers.dev and requires it on best.serp.co', async () => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/'
        ? new Response(`<html><head></head><body>${googleTagManager}</body></html>`, {
            headers: response.headers
          })
        : response
    )
    await expect(gates('staging', stagingOrigin)).rejects.toThrow(
      'staging route / loads Google Tag Manager'
    )
    await expect(gates('production', origin)).rejects.toThrow(
      'production route / loads Google Tag Manager'
    )
    stubCrawlPolicy((url, response) =>
      url.pathname === '/'
        ? new Response('<html><head></head><body>ok</body></html>', { headers: response.headers })
        : response
    )
    for (const mode of ['production', 'public'])
      await expect(gates(mode, origin)).rejects.toThrow(
        'best.serp.co route / does not load Google Tag Manager'
      )
  })

  it('rejects the Cloudflare Web Analytics beacon on workers.dev (#170)', async () => {
    const beacon =
      '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="{}"></script>'
    stubCrawlPolicy((url, response) =>
      url.pathname === '/'
        ? new Response(`<html><head></head><body>ok${beacon}</body></html>`, {
            headers: response.headers
          })
        : response
    )
    await expect(gates('staging', stagingOrigin)).rejects.toThrow(
      'staging route / loads the Cloudflare Web Analytics beacon'
    )
    await expect(gates('production', origin)).rejects.toThrow(
      'production route / loads the Cloudflare Web Analytics beacon'
    )
  })

  it.each([
    ['production', origin, 'staging', 'production'],
    ['production', origin, null, 'production'],
    ['staging', stagingPlatformOrigin, 'production', 'staging'],
    ['staging', stagingCanonicalOrigin, 'production', 'staging'],
    ['staging', platformOrigin, 'staging', 'production']
  ])(
    'requires %s gates on %s to see the Worker report SITE_ENVIRONMENT %s',
    async (mode, given, reported, expected) => {
      stubCrawlPolicy((_url, response) => {
        const headers = new Headers(response.headers)
        if (reported) headers.set(SITE_ENVIRONMENT_HEADER, reported)
        else headers.delete(SITE_ENVIRONMENT_HEADER)
        return new Response(response.body, { headers, status: response.status })
      })
      await expect(gates(mode, given)).rejects.toThrow(
        `reports SITE_ENVIRONMENT ${reported ?? '(none)'}, not ${expected}`
      )
    }
  )

  it('rejects a Staging origin that redirects requests without the smoke-test header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        if (!new Headers(init?.headers).has(SMOKE_TEST_HEADER))
          return new Response(null, { status: 308, headers: { location: `${origin}/` } })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    await expect(gates('staging', stagingOrigin)).rejects.toThrow(
      `without the smoke-test header returned 308 ${origin}/; this origin must not redirect`
    )
  })

  it.each([
    ['/', 'noindex, nofollow', 'route / sent noindex in its X-Robots-Tag header'],
    ['/', 'googlebot: noindex', 'route / sent noindex in its X-Robots-Tag header'],
    ['/sitemap-index.xml', 'none', '/sitemap-index.xml sent X-Robots-Tag noindex'],
    ['/robots.txt', 'NOINDEX', '/robots.txt sent X-Robots-Tag noindex']
  ])('rejects a public best.serp.co X-Robots-Tag on %s of %s', async (path, value, message) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === path ? withHeader(response, 'x-robots-tag', value) : response
    )
    await expect(gates('public', origin)).rejects.toThrow(message)
  })

  it.each([
    'max-image-preview: none',
    'max-image-preview:large, max-snippet:-1',
    'bingbot: noindex',
    'noarchive, nosnippet'
  ])(
    'accepts a public best.serp.co X-Robots-Tag of %s, which still lets Google index',
    async value => {
      stubCrawlPolicy((_url, response) => withHeader(response, 'x-robots-tag', value))
      await expect(gates('public', origin)).resolves.toBeUndefined()
    }
  )

  it.each([
    '<meta name="robots" content="noindex, nofollow"/>',
    "<meta content='none' name='googlebot'>",
    '<META NAME="ROBOTS" CONTENT="index, NOINDEX">'
  ])('rejects a public best.serp.co home page carrying %s', async tag => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/'
        ? new Response(`<html><head><title>SERP</title>${tag}</head><body></body></html>`, {
            headers: response.headers
          })
        : response
    )
    await expect(gates('public', origin)).rejects.toThrow('sent noindex in its robots meta')
  })

  it.each([
    ['no Sitemap line', 'User-agent: *\nAllow: /\n', 'does not list'],
    [
      "Staging's sitemap",
      `User-agent: *\nAllow: /\nSitemap: ${stagingOrigin}/sitemap-index.xml\n`,
      'does not list'
    ],
    [
      'Disallow: / for *',
      `User-agent: *\nDisallow: /\nSitemap: ${origin}/sitemap-index.xml\n`,
      'blocks / for user-agent *'
    ],
    [
      'Disallow: /* for *',
      `User-agent: *\nDisallow: /*\nSitemap: ${origin}/sitemap-index.xml\n`,
      'blocks / for user-agent *'
    ],
    [
      'Disallow: / with a trailing comment',
      `User-agent: *\nDisallow: / # everything\nSitemap: ${origin}/sitemap-index.xml\n`,
      'blocks / for user-agent *'
    ],
    [
      'Disallow: / for Googlebot only',
      `User-agent: *\nAllow: /\n\nUser-agent: Googlebot\nDisallow: /\nSitemap: ${origin}/sitemap-index.xml\n`,
      'blocks / for user-agent googlebot'
    ],
    [
      'only the home page allowed',
      `User-agent: *\nAllow: /$\nDisallow: /\nSitemap: ${origin}/sitemap-index.xml\n`,
      `blocks /products/${slug}/ for user-agent *`
    ]
  ])('rejects a public best.serp.co robots.txt with %s', async (_label, robots, message) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/robots.txt'
        ? new Response(robots, { headers: response.headers })
        : response
    )
    await expect(gates('public', origin)).rejects.toThrow(message)
  })

  it.each([
    [
      'a Disallow: / group for another bot',
      `User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${origin}/sitemap-index.xml\n`
    ],
    [
      'a managed AI-crawler block ahead of the site rules',
      `# BEGIN Cloudflare Managed content\nUser-agent: *\nContent-signal: search=yes,ai-train=no\nAllow: /\n\nUser-agent: Amazonbot\nUser-agent: ClaudeBot\nDisallow: /\n# END Cloudflare Managed Content\n\nUser-Agent: *\nAllow: /\nDisallow: /404\nDisallow: /submit\nDisallow: /search\n\nsitemap:   ${origin}/sitemap-index.xml\n`
    ],
    [
      'the rules best.serp.co serves today',
      `User-Agent: *\nAllow: /\nDisallow: /404\nDisallow: /500\nDisallow: /submit\nDisallow: /search\n\nSitemap: ${origin}/sitemap-index.xml\n`
    ]
  ])('accepts a public best.serp.co robots.txt with %s', async (_label, robots) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/robots.txt'
        ? new Response(robots, { headers: response.headers })
        : response
    )
    await expect(gates('public', origin)).resolves.toBeUndefined()
  })
})

describe('crawl policy readers', () => {
  it('counts only whole noindex or none directives for Google or every crawler', () => {
    expect(xRobotsTagBlocksIndexing(null)).toBe(false)
    expect(xRobotsTagBlocksIndexing('noindex')).toBe(true)
    expect(xRobotsTagBlocksIndexing('nofollow, NONE')).toBe(true)
    expect(xRobotsTagBlocksIndexing('googlebot: nofollow, noindex')).toBe(true)
    expect(xRobotsTagBlocksIndexing('otherbot: noindex, googlebot: noindex')).toBe(true)
    expect(xRobotsTagBlocksIndexing('otherbot: noindex, nofollow')).toBe(false)
    expect(xRobotsTagBlocksIndexing('max-image-preview: none, max-snippet: 20')).toBe(false)
    expect(xRobotsTagBlocksIndexing('unavailable_after: 2030-01-01T00:00:00Z')).toBe(false)
    expect(xRobotsTagBlocksIndexing('noindexer, indexnone')).toBe(false)
  })

  it('reads robots and googlebot meta tags only from the document head', () => {
    expect(metaRobotsBlocksIndexing('<head><meta name="robots" content="index"></head>')).toBe(
      false
    )
    expect(metaRobotsBlocksIndexing('<head><meta name="googlebot" content="noindex"></head>')).toBe(
      true
    )
    expect(metaRobotsBlocksIndexing('<head><meta name="bingbot" content="noindex"></head>')).toBe(
      false
    )
    expect(
      metaRobotsBlocksIndexing('<head></head><body><meta name="robots" content="noindex"></body>')
    ).toBe(false)
  })

  it('applies the longest matching rule of the group for each crawler', () => {
    const robots = 'User-agent: *\nDisallow: /search\nAllow: /\n\nUser-agent: BadBot\nDisallow: /\n'
    expect(robotsTxtBlockedPath(robots, ['/', '/products/a/'])).toBeNull()
    expect(robotsTxtBlockedPath(robots, ['/search/'])).toEqual({ agent: '*', path: '/search/' })
    expect(robotsTxtBlockedPath('User-agent: *\nDisallow:\n', ['/'])).toBeNull()
    expect(robotsTxtBlockedPath('Disallow: /\n', ['/'])).toBeNull()
    expect(robotsTxtBlockedPath('', ['/'])).toBeNull()
    expect(
      robotsTxtBlockedPath('User-agent: *\nDisallow: /pro*$\nAllow: /products/\n', ['/products/a/'])
    ).toBeNull()
  })
})

describe('smoke-test header and deployed Worker version', () => {
  const deployed = '0a1b2c3d-0000-4000-8000-00000000d0d0'
  const previous = '0a1b2c3d-0000-4000-8000-0000000000aa'

  /** A correct deployment whose responses report `answering()` as their Worker version. */
  function stubVersioned(answering: (url: URL) => string | null) {
    const requests: Array<{ smoke: boolean; url: URL }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        requests.push({ smoke: new Headers(init?.headers).has(SMOKE_TEST_HEADER), url })
        const response = withCrawlPolicy(url, successfulResponse(url))
        const version = answering(url)
        return version ? withHeader(response, WORKER_VERSION_HEADER, version) : response
      })
    )
    return requests
  }

  /** A virtual clock: sleeping advances it instantly, so budgets are exact and tests are fast. */
  function virtualClock(): GateClock & { elapsed(): number } {
    let now = 0
    return {
      elapsed: () => now,
      now: () => now,
      sleep: async milliseconds => {
        now += milliseconds
      }
    }
  }

  const pinned = (clock = virtualClock()) => ({
    clock,
    expectedVersion: deployed,
    versionPollIntervalMs: 1_000
  })

  it('sends the smoke-test header on every gate request but the host checks', async () => {
    const staging = stubVersioned(() => null)
    await expect(gates('staging', stagingOrigin)).resolves.toBeUndefined()
    expect(staging.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${stagingOrigin}/`
    ])
    const production = stubVersioned(() => null)
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(production.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${platformOrigin}/`,
      ...PUBLIC_POLICY_PATHS.map(path => `${origin}${path}`)
    ])
  })

  it('waits until the deployed version answers, then requires it on every response', async () => {
    let probes = 0
    const requests = stubVersioned(url => {
      if (url.pathname !== '/robots.txt' || probes >= 5) return deployed
      probes += 1
      return probes <= 2 ? previous : deployed
    })
    await expect(gates('staging', stagingOrigin, undefined, pinned())).resolves.toBeUndefined()
    // Two answers from the previous version, then three in a row from the deployed one.
    expect(requests.slice(0, 5).map(request => request.url.pathname)).toEqual(
      Array(5).fill('/robots.txt')
    )
    expect(requests[5]?.url.pathname).not.toBe('/robots.txt')
  })

  it('waits on the production platform host, and pins best.serp.co to the same version', async () => {
    let publicAnswers = 0
    const requests = stubVersioned(url => {
      if (url.origin !== origin) return deployed
      publicAnswers += 1
      return publicAnswers === 1 ? previous : deployed
    })
    await expect(gates('production', origin, undefined, pinned())).resolves.toBeUndefined()
    expect(requests.slice(0, 3).map(request => request.url.href)).toEqual(
      Array(3).fill(`${platformOrigin}/robots.txt`)
    )
    // best.serp.co's first answer came from the previous version and was retried.
    expect(
      requests.filter(request => request.url.origin === origin).map(request => request.url.pathname)
    ).toEqual(['/', '/', '/sitemap-index.xml', '/robots.txt'])
  })

  it('fails when the deployed version never answers within the bound', async () => {
    const requests = stubVersioned(() => previous)
    const clock = virtualClock()
    await expect(
      gates('staging', stagingOrigin, undefined, { ...pinned(clock), versionWaitMs: 10_000 })
    ).rejects.toThrow(
      `Worker version ${deployed} did not answer ${stagingOrigin} within 10 s (last answer: ${previous})`
    )
    expect(requests).toHaveLength(11)
    expect(clock.elapsed()).toBe(10_000)
    await expect(
      waitForWorkerVersion(new URL(stagingOrigin), deployed, { waitMs: 60_001 })
    ).rejects.toThrow('at most 60 seconds')
  })

  // PR #47 review: one answer from an isolate still on the previous version must not turn a
  // good deploy red; the retry shares the 60 s budget of the wait.
  it('retries an answer from the previous version within the version budget', async () => {
    let rssAnswers = 0
    const requests = stubVersioned(url => {
      if (url.pathname !== '/rss.xml') return deployed
      rssAnswers += 1
      return rssAnswers <= 2 ? previous : deployed
    })
    await expect(gates('production', origin, undefined, pinned())).resolves.toBeUndefined()
    expect(requests.filter(request => request.url.pathname === '/rss.xml')).toHaveLength(3)
  })

  it('fails closed when the previous version still answers once the budget runs out', async () => {
    const clock = virtualClock()
    const requests = stubVersioned(url => (url.pathname === '/rss.xml' ? previous : deployed))
    await expect(
      gates('production', origin, undefined, { ...pinned(clock), versionWaitMs: 20_000 })
    ).rejects.toThrow(
      `production route /rss.xml was answered by Worker version ${previous}, not the deployed ${deployed}, on all 19 attempt(s) before the 20 s version budget ran out`
    )
    // The wait spent 2 s of the shared budget (three probes 1 s apart); the retries the rest.
    expect(clock.elapsed()).toBe(20_000)
    expect(requests.filter(request => request.url.pathname === '/rss.xml')).toHaveLength(19)
  })

  it('reads the deployed version from Wrangler output', () => {
    const output = [
      JSON.stringify({ type: 'wrangler-session', version: 1 }),
      JSON.stringify({ type: 'deploy', version: 1, version_id: previous }),
      '',
      JSON.stringify({ type: 'deploy', version: 1, version_id: deployed, worker_name: 'w' })
    ].join('\n')
    expect(deployedWorkerVersion(output)).toBe(deployed)
    expect(() => deployedWorkerVersion('{"type":"version-upload"}')).toThrow('no Wrangler deploy')
    expect(() => deployedWorkerVersion('not json')).toThrow('not JSON')
    expect(() =>
      deployedWorkerVersion(JSON.stringify({ type: 'deploy', version_id: 'bad id;' }))
    ).toThrow('invalid Worker version')

    const outputPath = join(fixtureDirectory, 'wrangler-output.ndjson')
    writeFileSync(outputPath, output)
    expect(expectedWorkerVersionFromEnvironment({ WRANGLER_OUTPUT_FILE_PATH: outputPath })).toBe(
      deployed
    )
    expect(
      expectedWorkerVersionFromEnvironment({
        EXPECTED_WORKER_VERSION: previous,
        WRANGLER_OUTPUT_FILE_PATH: outputPath
      })
    ).toBe(previous)
    expect(expectedWorkerVersionFromEnvironment({})).toBeUndefined()
    expect(() =>
      expectedWorkerVersionFromEnvironment({
        WRANGLER_OUTPUT_FILE_PATH: join(fixtureDirectory, 'missing.ndjson')
      })
    ).toThrow('is unreadable')
  })
})

describe('production canonical-host redirect gate', () => {
  function wranglerConfig(value: string): string {
    const path = join(fixtureDirectory, `wrangler-${value}.jsonc`)
    writeFileSync(
      path,
      JSON.stringify({ env: { production: { vars: { CANONICAL_HOST_REDIRECT: value } } } })
    )
    return path
  }

  /**
   * The production Worker on its platform host. With `redirecting`, a request without the smoke
   * header gets a 308 to `location(url)`, as with CANONICAL_HOST_REDIRECT=on.
   */
  function stubPlatform(
    redirecting: boolean,
    location = (url: URL) => `${origin}${url.pathname}/${url.search}`
  ) {
    const requests: Array<{ smoke: boolean; url: URL }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const smoke = new Headers(init?.headers).has(SMOKE_TEST_HEADER)
        requests.push({ smoke, url })
        if (redirecting && !smoke && url.origin === platformOrigin)
          return new Response(null, { status: 308, headers: { location: location(url) } })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    return requests
  }

  const withSwitch = (value: string) => ({ wranglerConfigPath: wranglerConfig(value) })

  it('checks the 308 on the platform host when the checked-in switch is on', async () => {
    const on = stubPlatform(true)
    await expect(gates('production', origin, undefined, withSwitch('on'))).resolves.toBeUndefined()
    expect(on.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${platformOrigin}/about?gate=canonical-host`,
      ...PUBLIC_POLICY_PATHS.map(path => `${origin}${path}`)
    ])
  })

  it('requires the platform host to serve requests while the switch is off', async () => {
    const off = stubPlatform(false)
    await expect(gates('production', origin, undefined, withSwitch('off'))).resolves.toBeUndefined()
    expect(off.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${platformOrigin}/`,
      ...PUBLIC_POLICY_PATHS.map(path => `${origin}${path}`)
    ])
    stubPlatform(true)
    await expect(gates('production', origin, undefined, withSwitch('off'))).rejects.toThrow(
      `production route / without the smoke-test header returned 308 ${origin}//; this origin must not redirect`
    )
  })

  it('requires one 308 to the same canonical URL on best.serp.co', async () => {
    stubPlatform(true, () => '/about/?gate=canonical-host')
    await expect(gates('production', origin, undefined, withSwitch('on'))).rejects.toThrow(
      `not a 308 to ${origin}/about/?gate=canonical-host`
    )
    // Switch on in the config but not in the deployed Worker: only the slash rule answers.
    stubPlatform(false)
    await expect(gates('production', origin, undefined, withSwitch('on'))).rejects.toThrow(
      `returned 308 /about/, not a 308 to ${origin}/about/?gate=canonical-host`
    )
  })

  it('refuses a switch that is neither on nor off', async () => {
    stubPlatform(false)
    await expect(gates('production', origin, undefined, withSwitch('yes'))).rejects.toThrow(
      'CANONICAL_HOST_REDIRECT must be on or off'
    )
  })
})

// #323: staging mirrors production's host setup on staging.best.serp.co.
describe('staging canonical-host redirect gate', () => {
  function wranglerConfig(staging: string, production = 'off'): string {
    const path = join(fixtureDirectory, `wrangler-staging-${staging}-${production}.jsonc`)
    writeFileSync(
      path,
      JSON.stringify({
        env: {
          production: { vars: { CANONICAL_HOST_REDIRECT: production } },
          staging: { vars: { CANONICAL_HOST_REDIRECT: staging } }
        }
      })
    )
    return path
  }

  const withSwitch = (staging: string, production?: string) => ({
    wranglerConfigPath: wranglerConfig(staging, production)
  })

  /**
   * The staging Worker on its platform host. With `redirecting`, a request without the smoke
   * header gets a 308 to `location(url)`, as with staging's CANONICAL_HOST_REDIRECT=on.
   */
  function stubStagingPlatform(
    redirecting: boolean,
    location = (url: URL) => `${stagingCanonicalOrigin}${url.pathname}/${url.search}`
  ) {
    const requests: Array<{ smoke: boolean; url: URL }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const smoke = new Headers(init?.headers).has(SMOKE_TEST_HEADER)
        requests.push({ smoke, url })
        if (redirecting && !smoke && url.origin === stagingPlatformOrigin)
          return new Response(null, { status: 308, headers: { location: location(url) } })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    return requests
  }

  it.each([stagingCanonicalOrigin, stagingPlatformOrigin])(
    'gates staging given %s through its platform host, and checks the 308 to staging.best.serp.co',
    async given => {
      const requests = stubStagingPlatform(true)
      await expect(gates('staging', given, undefined, withSwitch('on'))).resolves.toBeUndefined()
      expect(requests.every(request => request.url.origin === stagingPlatformOrigin)).toBe(true)
      expect(requests.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
        `${stagingPlatformOrigin}/about?gate=canonical-host`
      ])
    }
  )

  it('requires one 308 to the same URL on staging.best.serp.co, not best.serp.co', async () => {
    stubStagingPlatform(true, url => `${origin}${url.pathname}/${url.search}`)
    await expect(
      gates('staging', stagingCanonicalOrigin, undefined, withSwitch('on'))
    ).rejects.toThrow(
      `staging platform host best-serp-co-staging.serpcompany.workers.dev/about without the smoke-test header returned 308 ${origin}/about/?gate=canonical-host, not a 308 to ${stagingCanonicalOrigin}/about/?gate=canonical-host`
    )
    // The switch on in the config but not in the deployed Worker: only the slash rule answers.
    stubStagingPlatform(false)
    await expect(
      gates('staging', stagingCanonicalOrigin, undefined, withSwitch('on'))
    ).rejects.toThrow(`returned 308 /about/, not a 308 to ${stagingCanonicalOrigin}/about/`)
  })

  it('requires the staging platform host to serve requests while its switch is off', async () => {
    const off = stubStagingPlatform(false)
    await expect(
      gates('staging', stagingCanonicalOrigin, undefined, withSwitch('off'))
    ).resolves.toBeUndefined()
    expect(off.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${stagingPlatformOrigin}/`
    ])
    stubStagingPlatform(true)
    await expect(
      gates('staging', stagingCanonicalOrigin, undefined, withSwitch('off'))
    ).rejects.toThrow('this origin must not redirect')
  })

  it("reads staging's switch only for staging's platform host, never production's", async () => {
    expect(canonicalHostRedirectConfigured(wranglerConfig('on', 'off'), 'staging')).toBe(true)
    expect(canonicalHostRedirectConfigured(wranglerConfig('on', 'off'))).toBe(false)
    expect(() => canonicalHostRedirectConfigured(wranglerConfig('yes'), 'staging')).toThrowError(
      /env\.staging\.vars\.CANONICAL_HOST_REDIRECT must be on or off/u
    )
    // Deploy Production's pre-cutover run (staging gates on the production platform host) and
    // any other staging origin still require `/` to be served, whatever staging's switch says.
    for (const given of [platformOrigin, stagingOrigin]) {
      const requests = stubStagingPlatform(true)
      await expect(gates('staging', given, undefined, withSwitch('yes'))).resolves.toBeUndefined()
      expect(requests.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
        `${given}/`
      ])
    }
    // Production's gates never read staging's switch.
    stubCrawlPolicy((_url, response) => response)
    await expect(
      gates('production', origin, undefined, withSwitch('yes', 'off'))
    ).resolves.toBeUndefined()
  })

  it('retries a 308 check answered by the previous Worker version, like production', async () => {
    const deployed = '0a1b2c3d-0000-4000-8000-00000000d0d0'
    const previous = '0a1b2c3d-0000-4000-8000-0000000000aa'
    let hostChecks = 0
    let now = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const smoke = new Headers(init?.headers).has(SMOKE_TEST_HEADER)
        if (smoke)
          return withHeader(
            withCrawlPolicy(url, successfulResponse(url)),
            WORKER_VERSION_HEADER,
            deployed
          )
        hostChecks += 1
        // The previous deployment, without the switch, still answers the first check.
        if (hostChecks === 1) return withHeader(new Response('ok'), WORKER_VERSION_HEADER, previous)
        return withHeader(
          new Response(null, {
            headers: { location: `${stagingCanonicalOrigin}/about/?gate=canonical-host` },
            status: 308
          }),
          WORKER_VERSION_HEADER,
          deployed
        )
      })
    )
    await expect(
      gates('staging', stagingCanonicalOrigin, undefined, {
        ...withSwitch('on'),
        clock: {
          now: () => now,
          sleep: async ms => {
            now += ms
          }
        },
        expectedVersion: deployed,
        versionPollIntervalMs: 1_000
      })
    ).resolves.toBeUndefined()
    expect(hostChecks).toBe(2)
  })
})

describe('best.serp.co public policy in the production gates', () => {
  const warnings = () =>
    vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .filter(line => line.startsWith('::warning'))

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  /**
   * best.serp.co answers with `answer(url, response)`; the platform host is a correct Worker,
   * which with `redirecting` (CANONICAL_HOST_REDIRECT=on) 308s requests without the smoke header.
   */
  function stubPublic(
    answer: (url: URL, response: Response) => Response | Promise<Response>,
    redirecting = false
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.origin === origin) return answer(url, withCrawlPolicy(url, successfulResponse(url)))
        if (redirecting && !new Headers(init?.headers).has(SMOKE_TEST_HEADER))
          return new Response(null, {
            headers: { location: `${origin}/about/?gate=canonical-host` },
            status: 308
          })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
  }

  const switchOn = () => {
    const path = join(fixtureDirectory, 'wrangler-public-on.jsonc')
    writeFileSync(
      path,
      JSON.stringify({ env: { production: { vars: { CANONICAL_HOST_REDIRECT: 'on' } } } })
    )
    return { wranglerConfigPath: path }
  }

  it.each([
    [
      'a Cloudflare challenge',
      () =>
        new Response('Just a moment...', {
          headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
          status: 403
        }),
      'cf-mitigated: challenge'
    ],
    [
      'a 403 block without Worker headers',
      () => new Response('Forbidden', { headers: { server: 'cloudflare' }, status: 403 }),
      'a 403 without Worker headers (server: cloudflare), zone protection'
    ],
    [
      'a 429 rate limit without Worker headers',
      () => new Response('Slow down', { headers: { server: 'cloudflare' }, status: 429 }),
      'a 429 without Worker headers (server: cloudflare), zone protection'
    ],
    [
      'GitHub Pages before the cutover',
      () => new Response('<html></html>', { headers: { server: 'GitHub.com' } }),
      'GitHub Pages (server: GitHub.com'
    ]
  ])('skips with a warning when best.serp.co answers with %s', async (_label, answer, seen) => {
    stubPublic(() => answer())
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(warnings()).toHaveLength(3)
    for (const warning of warnings()) {
      expect(warning).toContain('::warning title=best.serp.co check skipped::')
      expect(warning).toContain(seen)
    }
  })

  // PR #47 review round 3: only zone protection is skipped. A Worker over its limits (Cloudflare
  // 1102, a 503 without Worker headers) or a best.serp.co that does not answer (a timeout, a
  // detached Custom Domain, missing DNS) fails, whether the switch is on or off.
  it.each([
    [
      'a 503 without Worker headers',
      () =>
        new Response('Worker exceeded resource limits', {
          headers: { server: 'cloudflare' },
          status: 503
        }),
      'best.serp.co route / was not answered by the production Worker (x-site-environment (none), status 503, server cloudflare)'
    ],
    [
      'no answer',
      () => {
        throw new TypeError('fetch failed')
      },
      'best.serp.co route / got no answer (fetch failed)'
    ]
  ])('fails when best.serp.co answers with %s', async (_label, answer, message) => {
    for (const redirecting of [false, true]) {
      stubPublic(() => answer(), redirecting)
      await expect(
        gates('production', origin, undefined, redirecting ? switchOn() : {})
      ).rejects.toThrow(message)
    }
    expect(warnings()).toEqual([])
  })

  it('fails on GitHub Pages while CANONICAL_HOST_REDIRECT is on', async () => {
    // A switch flipped before the cutover: the platform host redirects to GitHub Pages.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.origin === origin)
          return new Response('<html></html>', { headers: { server: 'GitHub.com' } })
        if (!new Headers(init?.headers).has(SMOKE_TEST_HEADER))
          return new Response(null, {
            headers: { location: `${origin}/about/?gate=canonical-host` },
            status: 308
          })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    await expect(gates('production', origin, undefined, switchOn())).rejects.toThrow(
      'CANONICAL_HOST_REDIRECT is on, but best.serp.co/ is still GitHub Pages'
    )
  })

  it.each([
    [
      'noindex in its X-Robots-Tag',
      (url: URL, response: Response) =>
        url.pathname === '/' ? withHeader(response, 'x-robots-tag', 'noindex') : response,
      'best.serp.co route / sent noindex in its X-Robots-Tag header'
    ],
    [
      'no Google Tag Manager',
      (url: URL, response: Response) =>
        url.pathname === '/'
          ? new Response('<html><head></head><body>ok</body></html>', { headers: response.headers })
          : response,
      'best.serp.co route / does not load Google Tag Manager'
    ],
    [
      'a robots.txt without the sitemap index',
      (url: URL, response: Response) =>
        url.pathname === '/robots.txt'
          ? new Response('User-agent: *\nAllow: /\n', { headers: response.headers })
          : response,
      'best.serp.co robots.txt does not list'
    ],
    [
      'a staging Worker',
      (_url: URL, response: Response) => withHeader(response, SITE_ENVIRONMENT_HEADER, 'staging'),
      'best.serp.co route / was not answered by the production Worker (x-site-environment staging'
    ],
    [
      'something else without Worker headers',
      () => new Response('<html></html>', { headers: { server: 'cloudflare' } }),
      'best.serp.co route / was not answered by the production Worker (x-site-environment (none), status 200, server cloudflare)'
    ]
  ])('fails when best.serp.co serves %s', async (_label, answer, message) => {
    stubPublic(answer)
    await expect(gates('production', origin)).rejects.toThrow(message)
    expect(warnings()).toEqual([])
  })

  it('never skips in the manual public check', async () => {
    stubPublic(
      () =>
        new Response('Just a moment...', {
          headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
          status: 403
        })
    )
    await expect(gates('public', origin)).rejects.toThrow(
      'best.serp.co route / was not answered by the production Worker (x-site-environment (none), status 403, server cloudflare, cf-mitigated challenge)'
    )
  })
})

describe('admin lock gate', () => {
  const accessConfiguredPath = join(fixtureDirectory, 'wrangler-access-on.jsonc')
  writeFileSync(
    accessConfiguredPath,
    JSON.stringify({
      env: {
        production: {
          vars: {
            CANONICAL_HOST_REDIRECT: 'off',
            CF_ACCESS_AUD: 'f'.repeat(64),
            CF_ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com'
          }
        },
        staging: { vars: { CANONICAL_HOST_REDIRECT: 'off', CF_ACCESS_REQUIRED: 'on' } }
      }
    })
  )
  const adminAnswer = (status: number) => (url: URL, response: Response) =>
    ['/admin/', '/api/admin'].includes(url.pathname)
      ? new Response(status === 204 ? null : 'admin', { headers: response.headers, status })
      : response

  it('derives the expected answer from the checked-in production and staging vars', () => {
    // Production has the owner's Access app values, so it must answer 403; staging has no
    // Access lock, so 401 (no session).
    expect(adminLockStatusesFromConfig()).toEqual({ production: 403, staging: 401 })
    const wrangler = JSON.parse(readFileSync(resolve('apps/web/wrangler.jsonc'), 'utf8')) as {
      env: { production: { vars: AccessEnv } }
    }
    expect(accessConfig(wrangler.env.production.vars)).toEqual({
      audience: wrangler.env.production.vars.CF_ACCESS_AUD,
      certsUrl: 'https://serpcompany.cloudflareaccess.com/cdn-cgi/access/certs',
      issuer: 'https://serpcompany.cloudflareaccess.com'
    })
    expect(adminLockStatusesFromConfig(switchOffConfigPath)).toEqual({
      production: 503,
      staging: 401
    })
    expect(adminLockStatusesFromConfig(accessConfiguredPath)).toEqual({
      production: 403,
      staging: 503
    })
    expect(
      expectedAdminLockStatus({ SITE_ENVIRONMENT: 'staging', CF_ACCESS_REQUIRED: 'off' })
    ).toBe(401)
    expect(allowedAdminLockStatuses(null, { production: 403, staging: 401 })).toEqual([
      401, 403, 503
    ])
  })

  it.each([200, 204, 308, 401, 404, 500, 503])(
    'fails a production deploy with Access configured whose admin route answers %i',
    async status => {
      stubCrawlPolicy(adminAnswer(status))
      await expect(
        gates('production', origin, undefined, { wranglerConfigPath: accessConfiguredPath })
      ).rejects.toThrow(`production admin route /admin/ returned ${status}, not 403`)
    }
  )

  it('accepts a production Worker with Access configured that answers 403', async () => {
    stubCrawlPolicy(adminAnswer(403))
    await expect(
      gates('production', origin, undefined, { wranglerConfigPath: accessConfiguredPath })
    ).resolves.toBeUndefined()
  })

  it('expects 503 from a production Worker whose Access vars are unset', async () => {
    stubCrawlPolicy(adminAnswer(403))
    await expect(gates('production', origin)).rejects.toThrow(
      'production admin route /admin/ returned 403, not 503'
    )
  })

  it('follows CF_ACCESS_REQUIRED on staging', async () => {
    const staging = stagingPlatformOrigin
    stubCrawlPolicy(adminAnswer(404))
    await expect(gates('staging', staging)).rejects.toThrow(
      'staging admin route /admin/ returned 404, not 401'
    )
    // With staging Access switched on but unconfigured, 401 is wrong and 503 is right.
    stubCrawlPolicy(adminAnswer(401))
    await expect(
      gates('staging', staging, undefined, { wranglerConfigPath: accessConfiguredPath })
    ).rejects.toThrow('staging admin route /admin/ returned 401, not 503')
    stubCrawlPolicy((url, response) =>
      withHeader(adminAnswer(503)(url, response), SITE_ENVIRONMENT_HEADER, 'staging')
    )
    await expect(
      gates('staging', staging, undefined, { wranglerConfigPath: accessConfiguredPath })
    ).resolves.toBeUndefined()
  })
})

describe('Better Auth smoke gates', () => {
  function installAuthFetch(answers: { badSignIn?: Response; session?: Response }) {
    const requests: Array<{ init?: RequestInit; url: URL }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        requests.push({ init, url })
        if (url.pathname === '/api/auth/get-session' && answers.session)
          return withCrawlPolicy(url, answers.session)
        if (url.pathname === badSignInPath && answers.badSignIn)
          return withCrawlPolicy(url, answers.badSignIn)
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    return requests
  }

  it.each([
    ['production', origin, 'https://best.serp.co'],
    ['production', platformOrigin, 'https://best.serp.co'],
    ['staging', stagingOrigin, stagingOrigin],
    // #323: through its platform host, staging's trusted origin is staging.best.serp.co.
    ['staging', stagingCanonicalOrigin, stagingCanonicalOrigin],
    ['staging', stagingPlatformOrigin, stagingCanonicalOrigin],
    // Deploy Production's pre-cutover run keeps its own origin.
    ['staging', platformOrigin, platformOrigin]
  ])(
    'sends %s on %s an empty-email sign-in from its trusted origin',
    async (mode, baseUrl, expected) => {
      const requests = installAuthFetch({})
      await expect(gates(mode, baseUrl)).resolves.toBeUndefined()
      const signIn = requests.find(request => request.url.pathname === badSignInPath)
      expect(signIn?.init?.method).toBe('POST')
      expect(JSON.parse(String(signIn?.init?.body))).toEqual({ email: '', type: 'sign-in' })
      expect(signIn?.init?.headers).toMatchObject({
        'content-type': 'application/json',
        origin: expected
      })
      expect(signIn?.init?.redirect).toBe('manual')
    }
  )

  it.each([
    [
      { session: new Response(null, { status: 302, headers: { location: '/login/' } }) },
      /get-session returned 302, not 200/u
    ],
    [{ session: new Response('error', { status: 500 }) }, /get-session returned 500, not 200/u],
    [
      { badSignIn: new Response(null, { status: 302, headers: { location: '/login/' } }) },
      /empty email returned 302, not 400 INVALID_EMAIL/u
    ],
    [
      { badSignIn: new Response('{"success":true}', { status: 200 }) },
      /empty email returned 200, not 400 INVALID_EMAIL/u
    ],
    // A CSRF refusal, a missing route, or the rate limit is a 4xx, but not the validation check.
    [
      { badSignIn: new Response('{"code":"INVALID_ORIGIN"}', { status: 403 }) },
      /empty email returned 403 INVALID_ORIGIN, not 400 INVALID_EMAIL/u
    ],
    [
      { badSignIn: new Response('Not found', { status: 404 }) },
      /empty email returned 404, not 400 INVALID_EMAIL/u
    ],
    [
      { badSignIn: new Response('{"code":"cooldown"}', { status: 429 }) },
      /empty email returned 429 cooldown, not 400 INVALID_EMAIL/u
    ],
    [
      { badSignIn: new Response('error', { status: 500 }) },
      /empty email returned 500, not 400 INVALID_EMAIL/u
    ]
  ])('fails when Better Auth answers %o', async (answers, message) => {
    installAuthFetch(answers)
    await expect(gates('staging', stagingOrigin)).rejects.toThrow(message)
  })
})
