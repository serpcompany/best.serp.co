import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import {
  SITE_ENVIRONMENT_HEADER,
  SMOKE_TEST_HEADER,
  WORKER_VERSION_HEADER
} from '../apps/web/lib/environment/site-environment'
import {
  metaRobotsBlocksIndexing,
  robotsTxtBlockedPath,
  xRobotsTagBlocksIndexing
} from './crawl-policy.ts'
import {
  deployedWorkerVersion,
  expectedWorkerVersionFromEnvironment,
  type GateClock,
  type HttpGateOptions,
  runHttpGates,
  waitForWorkerVersion
} from './d1-preview-http-gates.ts'

afterEach(() => vi.unstubAllGlobals())

const origin = 'https://best.serp.co'
/** Production gates go through the production Worker's platform host, never best.serp.co. */
const platformOrigin = 'https://best-serp-co-production.serpcompany.workers.dev'
const stagingOrigin = 'https://best-serp-co-staging.example.test'
const slug = 'example-product'
const category = 'seo-tools'
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-http-gates-'))
const parityReportPath = join(fixtureDirectory, 'parity.yaml')
writeFileSync(
  parityReportPath,
  stringify({
    parity: { categories: [{ slug: category }], exactSlugSet: [slug] },
    target: { checksum: 'a'.repeat(64) }
  })
)

afterAll(() => rmSync(fixtureDirectory, { force: true, recursive: true }))

function gates(
  mode: string,
  baseUrl: string,
  timeoutMs?: number,
  options: HttpGateOptions = {}
): Promise<void> {
  return runHttpGates(mode, baseUrl, { parityReportPath, timeoutMs, ...options })
}

/** Requests the trailing-slash gates make, and the canonical redirects they require. */
const trailingSlashGatePaths = ['/about', '/robots.txt/', '/api/search/']
const canonicalRedirects: Record<string, string> = {
  '/about': '/about/',
  '/robots.txt/': '/robots.txt'
}

function successfulResponse(url: URL, redirectLocation?: string, emptyBody = false): Response {
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
    'gates Production given %s through its platform host only',
    async given => {
      const urls = installSuccessfulFetch()
      await expect(gates('production', given)).resolves.toBeUndefined()
      expect(urls).toHaveLength(
        8 + trailingSlashGatePaths.length + CRAWL_POLICY_REQUESTS.production
      )
      // Never best.serp.co: the serp.co zone's bot protection must not decide a deploy.
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
          '/submit/'
        ])
      )
      expect(urls.some(url => url.pathname === '/api/search' && url.search.startsWith('?q='))).toBe(
        true
      )
    }
  )

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
// /, /sitemap-index.xml, /robots.txt, and / without the smoke header. The manual public check of
// best.serp.co fetches only /, /sitemap-index.xml and /robots.txt.
const CRAWL_POLICY_REQUESTS = { production: 4, public: 3, staging: 4 } as const

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
  headers.set(SITE_ENVIRONMENT_HEADER, url.origin === stagingOrigin ? 'staging' : 'production')
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
    expect(production.slice(-CRAWL_POLICY_REQUESTS.production).map(url => url.pathname)).toEqual([
      '/',
      '/sitemap-index.xml',
      '/robots.txt',
      '/'
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
      '/'
    ])
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
      url.pathname === '/' ? new Response('<html><head></head><body>ok</body></html>') : response
    )
    await expect(gates('public', origin)).rejects.toThrow(
      'public route / does not load Google Tag Manager'
    )
  })

  it.each([
    ['production', origin, 'staging', 'production'],
    ['production', origin, null, 'production'],
    ['staging', 'https://best-serp-co-staging.serpcompany.workers.dev', 'production', 'staging'],
    ['staging', platformOrigin, 'staging', 'production']
  ])(
    'requires %s gates on %s to see the Worker report SITE_ENVIRONMENT %s',
    async (mode, given, reported, expected) => {
      stubCrawlPolicy((url, response) => {
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
        ? new Response(`<html><head><title>SERP</title>${tag}</head><body></body></html>`)
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
      url.pathname === '/robots.txt' ? new Response(robots) : response
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
      url.pathname === '/robots.txt' ? new Response(robots) : response
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

  it('sends the smoke-test header on every gate request but the host-redirect check', async () => {
    for (const [mode, given] of [
      ['staging', stagingOrigin],
      ['production', origin]
    ]) {
      const requests = stubVersioned(() => null)
      await expect(gates(mode, given)).resolves.toBeUndefined()
      expect(
        requests.filter(request => !request.smoke).map(request => request.url.pathname)
      ).toEqual(['/'])
    }
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

  it('waits on the production platform host, never best.serp.co', async () => {
    const requests = stubVersioned(() => deployed)
    await expect(gates('production', origin, undefined, pinned())).resolves.toBeUndefined()
    expect(requests.slice(0, 3).map(request => request.url.href)).toEqual(
      Array(3).fill(`${platformOrigin}/robots.txt`)
    )
    expect(requests.every(request => request.url.origin === platformOrigin)).toBe(true)
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
        if (redirecting && !smoke)
          return new Response(null, { status: 308, headers: { location: location(url) } })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    return requests
  }

  const withSwitch = (value: string) => ({ wranglerConfigPath: wranglerConfig(value) })

  it('checks the 308 when the checked-in switch is on, without requesting best.serp.co', async () => {
    const on = stubPlatform(true)
    await expect(gates('production', origin, undefined, withSwitch('on'))).resolves.toBeUndefined()
    expect(on.every(request => request.url.origin === platformOrigin)).toBe(true)
    expect(on.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${platformOrigin}/about?gate=canonical-host`
    ])
  })

  it('requires the platform host to serve requests while the switch is off', async () => {
    const off = stubPlatform(false)
    await expect(gates('production', origin, undefined, withSwitch('off'))).resolves.toBeUndefined()
    expect(off.filter(request => !request.smoke).map(request => request.url.href)).toEqual([
      `${platformOrigin}/`
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
