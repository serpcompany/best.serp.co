import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import {
  metaRobotsBlocksIndexing,
  robotsTxtBlockedPath,
  xRobotsTagBlocksIndexing
} from './crawl-policy.ts'
import { runHttpGates } from './d1-preview-http-gates.ts'

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

function gates(mode: string, baseUrl: string, timeoutMs?: number): Promise<void> {
  return runHttpGates(mode, baseUrl, { parityReportPath, timeoutMs })
}

function successfulResponse(url: URL, redirectLocation?: string, emptyBody = false): Response {
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
    expect(urls).toHaveLength(8 + CRAWL_POLICY_REQUESTS.production)
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
})

// Crawl policy (serp standards/environment-configuration.md). Kept apart from the route
// contracts above: after them, Production fetches /, /sitemap-index.xml and /robots.txt again,
// and Staging fetches / again.
const CRAWL_POLICY_REQUESTS = { production: 3, staging: 1 } as const

function correctRobotsTxt(robotsOrigin: string): string {
  return `User-Agent: *\nAllow: /\nDisallow: /search\nSitemap: ${robotsOrigin}/sitemap-index.xml\n`
}

/** What a correct deployment serves: Staging is noindex, Production lists its sitemap. */
function withCrawlPolicy(url: URL, response: Response): Response {
  const headers = new Headers(response.headers)
  if (url.origin !== origin) headers.set('x-robots-tag', 'noindex, nofollow')
  if (url.pathname === '/robots.txt')
    return new Response(correctRobotsTxt(url.origin), { status: 200, headers })
  if (url.pathname === '/')
    return new Response(
      '<html><head><title>SERP</title><meta name="robots" content="index, follow"/></head><body>ok</body></html>',
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
    expect(staging.slice(-CRAWL_POLICY_REQUESTS.staging).map(url => url.pathname)).toEqual(['/'])
  })

  it('requires Staging to send noindex in the header or the robots meta', async () => {
    stubCrawlPolicy((url, response) => {
      if (url.pathname !== '/') return response
      return new Response('<html><head><meta name="robots" content="noindex"></head></html>')
    })
    await expect(gates('staging', stagingOrigin)).resolves.toBeUndefined()
    stubCrawlPolicy((url, response) =>
      url.pathname === '/' ? new Response('<html><head></head></html>') : response
    )
    await expect(gates('staging', stagingOrigin)).rejects.toThrow('sent no noindex')
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
