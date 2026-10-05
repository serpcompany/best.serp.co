import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import {
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
  type HttpGateOptions,
  runHttpGates,
  waitForWorkerVersion
} from './d1-preview-http-gates.ts'

afterEach(() => vi.unstubAllGlobals())

const origin = 'https://best.serp.co'
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
  it('passes the exact Production origin and best.serp.co route contracts', async () => {
    const urls = installSuccessfulFetch()
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(urls).toHaveLength(8 + trailingSlashGatePaths.length + CRAWL_POLICY_REQUESTS.production)
    expect(urls.every(url => url.origin === origin)).toBe(true)
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
  })

  it('keeps Staging isolated from the Production hostname', async () => {
    installSuccessfulFetch()
    await expect(gates('staging', stagingOrigin)).resolves.toBeUndefined()
    await expect(gates('staging', origin)).rejects.toThrow('reject the Production hostname')
    await expect(gates('production', stagingOrigin)).rejects.toThrow(
      'exact https://best.serp.co origin'
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
    await expect(gates('preview', origin)).rejects.toThrow('exactly staging or production')
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
// route contracts above: after them, Production fetches /, /sitemap-index.xml and /robots.txt
// again, and Staging fetches /, /sitemap-index.xml, /robots.txt, and / without the smoke header.
const CRAWL_POLICY_REQUESTS = { production: 3, staging: 4 } as const

function correctRobotsTxt(robotsOrigin: string): string {
  if (robotsOrigin !== origin) return 'User-agent: *\nDisallow: /\n'
  return `User-Agent: *\nAllow: /\nDisallow: /search\nSitemap: ${robotsOrigin}/sitemap-index.xml\n`
}

const googleTagManager =
  '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-TEST"></iframe></noscript>'

/**
 * What a correct deployment serves: Staging is noindex everywhere, disallows crawling, and
 * loads no Google Tag Manager; Production lists its sitemap and loads Google Tag Manager.
 */
function withCrawlPolicy(url: URL, response: Response): Response {
  const headers = new Headers(response.headers)
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
      '/robots.txt'
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

  it('rejects Google Tag Manager outside Production and requires it on Production', async () => {
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
    stubCrawlPolicy((url, response) =>
      url.pathname === '/' ? new Response('<html><head></head><body>ok</body></html>') : response
    )
    await expect(gates('production', origin)).rejects.toThrow(
      'production route / does not load Google Tag Manager'
    )
  })

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
  ])('rejects a Production X-Robots-Tag on %s of %s', async (path, value, message) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === path ? withHeader(response, 'x-robots-tag', value) : response
    )
    await expect(gates('production', origin)).rejects.toThrow(message)
  })

  it.each([
    'max-image-preview: none',
    'max-image-preview:large, max-snippet:-1',
    'bingbot: noindex',
    'noarchive, nosnippet'
  ])('accepts a Production X-Robots-Tag of %s, which still lets Google index', async value => {
    stubCrawlPolicy((_url, response) => withHeader(response, 'x-robots-tag', value))
    await expect(gates('production', origin)).resolves.toBeUndefined()
  })

  it.each([
    '<meta name="robots" content="noindex, nofollow"/>',
    "<meta content='none' name='googlebot'>",
    '<META NAME="ROBOTS" CONTENT="index, NOINDEX">'
  ])('rejects a Production home page carrying %s', async tag => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/'
        ? new Response(`<html><head><title>SERP</title>${tag}</head><body></body></html>`)
        : response
    )
    await expect(gates('production', origin)).rejects.toThrow('sent noindex in its robots meta')
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
  ])('rejects a Production robots.txt with %s', async (_label, robots, message) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/robots.txt' ? new Response(robots) : response
    )
    await expect(gates('production', origin)).rejects.toThrow(message)
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
  ])('accepts a Production robots.txt with %s', async (_label, robots) => {
    stubCrawlPolicy((url, response) =>
      url.pathname === '/robots.txt' ? new Response(robots) : response
    )
    await expect(gates('production', origin)).resolves.toBeUndefined()
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

  const noWait = { sleep: async () => {}, versionPollIntervalMs: 1_000 }

  it('sends the smoke-test header on every gate request but the no-redirect check', async () => {
    const requests = stubVersioned(() => null)
    await expect(gates('staging', stagingOrigin)).resolves.toBeUndefined()
    expect(requests.filter(request => !request.smoke).map(request => request.url.pathname)).toEqual(
      ['/']
    )
    const production = stubVersioned(() => null)
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(production.every(request => request.smoke)).toBe(true)
  })

  it('waits until the deployed version answers, then requires it on every response', async () => {
    let probes = 0
    const requests = stubVersioned(url => {
      if (url.pathname !== '/robots.txt' || probes >= 5) return deployed
      probes += 1
      return probes <= 2 ? previous : deployed
    })
    await expect(
      gates('staging', stagingOrigin, undefined, { expectedVersion: deployed, ...noWait })
    ).resolves.toBeUndefined()
    // Two answers from the previous version, then three in a row from the deployed one.
    expect(requests.slice(0, 5).map(request => request.url.pathname)).toEqual(
      Array(5).fill('/robots.txt')
    )
    expect(requests[5]?.url.pathname).not.toBe('/robots.txt')
  })

  it('fails when the deployed version never answers within the bound', async () => {
    const requests = stubVersioned(() => previous)
    await expect(
      gates('staging', stagingOrigin, undefined, {
        expectedVersion: deployed,
        ...noWait,
        versionWaitMs: 10_000
      })
    ).rejects.toThrow(
      `Worker version ${deployed} did not answer ${stagingOrigin} within 10 s (last answer: ${previous})`
    )
    expect(requests.length).toBeLessThanOrEqual(11)
    await expect(
      waitForWorkerVersion(new URL(stagingOrigin), deployed, { waitMs: 60_001 })
    ).rejects.toThrow('at most 60 seconds')
  })

  it('fails a gate answered by another version after the wait', async () => {
    let answered = 0
    stubVersioned(url => {
      answered += 1
      return url.pathname === '/rss.xml' && answered > 3 ? previous : deployed
    })
    await expect(
      gates('production', origin, undefined, { expectedVersion: deployed, ...noWait })
    ).rejects.toThrow(
      `production route /rss.xml was answered by Worker version ${previous}, not the deployed ${deployed}`
    )
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
  const platform = 'https://best-serp-co-production.serpcompany.workers.dev'

  function wranglerConfig(value: string): string {
    const path = join(fixtureDirectory, `wrangler-${value}.jsonc`)
    writeFileSync(
      path,
      JSON.stringify({ env: { production: { vars: { CANONICAL_HOST_REDIRECT: value } } } })
    )
    return path
  }

  /** The production Worker with the switch on: workers.dev redirects unless the smoke header is sent. */
  function stubRedirecting(location = (url: URL) => `${origin}${url.pathname}/${url.search}`) {
    const requests: URL[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        requests.push(url)
        if (url.origin === platform && !new Headers(init?.headers).has(SMOKE_TEST_HEADER))
          return new Response(null, { status: 308, headers: { location: location(url) } })
        return withCrawlPolicy(url, successfulResponse(url))
      })
    )
    return requests
  }

  it('checks the platform host only when the checked-in switch is on', async () => {
    const off = stubRedirecting()
    await expect(
      gates('production', origin, undefined, { wranglerConfigPath: wranglerConfig('off') })
    ).resolves.toBeUndefined()
    expect(off.some(url => url.origin === platform)).toBe(false)

    const on = stubRedirecting()
    await expect(
      gates('production', origin, undefined, { wranglerConfigPath: wranglerConfig('on') })
    ).resolves.toBeUndefined()
    expect(on.filter(url => url.origin === platform).map(url => url.pathname)).toEqual([
      '/about',
      '/'
    ])
  })

  it('requires one 308 to the same canonical URL on best.serp.co', async () => {
    stubRedirecting(() => '/about/?gate=canonical-host')
    await expect(
      gates('production', origin, undefined, { wranglerConfigPath: wranglerConfig('on') })
    ).rejects.toThrow(`not a 308 to ${origin}/about/?gate=canonical-host`)
  })

  it('refuses a switch that is neither on nor off', async () => {
    stubRedirecting()
    await expect(
      gates('production', origin, undefined, { wranglerConfigPath: wranglerConfig('yes') })
    ).rejects.toThrow('CANONICAL_HOST_REDIRECT must be on or off')
  })
})
