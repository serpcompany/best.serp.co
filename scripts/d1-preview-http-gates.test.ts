import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
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
      return successfulResponse(url, redirectLocation, emptyBody)
    })
  )
  return urls
}

describe('environment-specific HTTP gates', () => {
  it('passes the exact Production origin and best.serp.co route contracts', async () => {
    const urls = installSuccessfulFetch()
    await expect(gates('production', origin)).resolves.toBeUndefined()
    expect(urls).toHaveLength(8)
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
