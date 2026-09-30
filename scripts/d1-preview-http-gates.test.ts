import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHttpGates, runPreviewHttpGates } from './d1-preview-http-gates.ts'

afterEach(() => vi.unstubAllGlobals())

const sampleSlugByHost: Record<string, string> = {
  'pornvideodownloaders.com': '321tube-downloader',
  'serp.software': '123movies-downloader'
}
const siteCases = [
  {
    otherProductionOrigin: 'https://pornvideodownloaders.com',
    origin: 'https://serp.software',
    previewOrigin: 'https://serp-preview.example.test',
    siteId: 'serp.software',
    slug: '123movies-downloader'
  },
  {
    otherProductionOrigin: 'https://serp.software',
    origin: 'https://pornvideodownloaders.com',
    previewOrigin: 'https://pvd-preview.example.test',
    siteId: 'pornvideodownloaders.com',
    slug: '321tube-downloader'
  }
] as const

function successfulResponse(
  url: URL,
  redirectLocation?: string,
  emptyBody = false,
  sampleSlug?: string
): Response {
  const slug = sampleSlug ?? sampleSlugByHost[url.hostname] ?? '123movies-downloader'
  if (url.pathname === `/${slug}/`)
    return new Response(null, {
      status: 308,
      headers: { location: redirectLocation ?? `/products/${slug}/` }
    })
  return new Response(emptyBody ? '' : 'ok', { status: 200 })
}

function installSuccessfulFetch(redirectLocation?: string, emptyBody = false, sampleSlug?: string) {
  const urls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input))
      urls.push(url)
      return successfulResponse(url, redirectLocation, emptyBody, sampleSlug)
    })
  )
  return urls
}

describe('environment-specific HTTP gates', () => {
  it.each([
    ['serp.software', 'https://serp.software'],
    ['pornvideodownloaders.com', 'https://pornvideodownloaders.com']
  ])('passes exact Production origin and route contracts for %s', async (siteId, origin) => {
    const urls = installSuccessfulFetch()
    await expect(runHttpGates('production', siteId, origin)).resolves.toBeUndefined()
    expect(urls).toHaveLength(8)
    expect(urls.every(url => url.origin === origin)).toBe(true)
    expect(urls.some(url => url.pathname === '/api/search' && url.search.startsWith('?q='))).toBe(
      true
    )
  })

  describe.each(siteCases)('$siteId negative contracts', testCase => {
    it('keeps Preview isolated from every Production hostname', async () => {
      installSuccessfulFetch(undefined, false, testCase.slug)
      await expect(
        runPreviewHttpGates(testCase.siteId, testCase.previewOrigin)
      ).resolves.toBeUndefined()
      await expect(runHttpGates('preview', testCase.siteId, testCase.origin)).rejects.toThrow(
        'every registered Production hostname'
      )
      await expect(
        runHttpGates('preview', testCase.siteId, testCase.otherProductionOrigin)
      ).rejects.toThrow('every registered Production hostname')
      await expect(
        runHttpGates('production', testCase.siteId, testCase.previewOrigin)
      ).rejects.toThrow(`exact https://${testCase.siteId} origin`)
    })

    it.each(['http:', 'port', 'credentials', 'path', 'query', 'hash'])(
      'rejects unsafe Production origin component %s',
      async variant => {
        const hostname = new URL(testCase.origin).hostname
        const baseUrl =
          variant === 'http:'
            ? `http://${hostname}`
            : variant === 'port'
              ? `https://${hostname}:8443`
              : variant === 'credentials'
                ? `https://user:pass@${hostname}`
                : variant === 'path'
                  ? `${testCase.origin}/path`
                  : variant === 'query'
                    ? `${testCase.origin}/?query=1`
                    : `${testCase.origin}/#hash`
        await expect(runHttpGates('production', testCase.siteId, baseUrl)).rejects.toThrow(
          'clean HTTPS origin'
        )
      }
    )

    it('requires nonempty bodies and successful statuses', async () => {
      installSuccessfulFetch(undefined, true)
      await expect(runHttpGates('production', testCase.siteId, testCase.origin)).rejects.toThrow(
        'no content'
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | RequestInfo) => {
          const url = new URL(String(input))
          if (url.pathname === '/rss.xml') return new Response('failed', { status: 500 })
          return successfulResponse(url)
        })
      )
      await expect(runHttpGates('production', testCase.siteId, testCase.origin)).rejects.toThrow(
        'returned 500'
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('ok', { status: 200 }))
      )
      await expect(runHttpGates('production', testCase.siteId, testCase.origin)).rejects.toThrow(
        'not a redirect'
      )
    })

    it.each(['other-origin', 'wrong-path', 'query', 'hash'])(
      'rejects redirect mismatch %s',
      async variant => {
        const location =
          variant === 'other-origin'
            ? `https://other-host.example/products/${testCase.slug}/`
            : variant === 'wrong-path'
              ? '/products/wrong/'
              : variant === 'query'
                ? `/products/${testCase.slug}/?unexpected=1`
                : `/products/${testCase.slug}/#unexpected`
        installSuccessfulFetch(location)
        await expect(runHttpGates('production', testCase.siteId, testCase.origin)).rejects.toThrow(
          'did not redirect'
        )
      }
    )
  })

  it('rejects unknown modes before making requests', async () => {
    await expect(runHttpGates('staging', 'serp.software', 'https://serp.software')).rejects.toThrow(
      'exactly preview or production'
    )
  })

  it('aborts requests that do not complete within the protected deadline', async () => {
    const aborted = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted()
              reject(new DOMException('aborted', 'AbortError'))
            })
          })
      )
    )
    await expect(
      runHttpGates('production', 'serp.software', 'https://serp.software', { timeoutMs: 5 })
    ).rejects.toThrow('bounded deadline')
    expect(aborted).toHaveBeenCalled()
  })

  it('makes every protected workflow select its environment mode explicitly', () => {
    const cutover = readFileSync('.github/workflows/cutover-d1-replatform-production.yml', 'utf8')
    const finalize = readFileSync('.github/workflows/finalize-d1-replatform-production.yml', 'utf8')
    const preview = readFileSync('.github/workflows/rehearse-d1-replatform-preview.yml', 'utf8')
    expect(cutover.match(/d1-preview-http-gates\.ts production/gu)).toHaveLength(2)
    expect(finalize.match(/d1-preview-http-gates\.ts production/gu)).toHaveLength(1)
    expect(preview.match(/d1-preview-http-gates\.ts preview/gu)).toHaveLength(3)
  })
})
