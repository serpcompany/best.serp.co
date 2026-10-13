import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '@/lib/directory/search-contract'

const logger = vi.hoisted(() => ({ error: vi.fn() }))
/** Entries whose slug starts with one of these fail at that step, as a bad shape would. */
const broken = vi.hoisted(() => ({ match: 'bad-match-', transform: 'bad-transform-' }))

vi.mock('@/lib/logging', () => ({ logger }))
vi.mock('./search-utils', async importOriginal => {
  const actual = await importOriginal<typeof import('./search-utils')>()
  return {
    ...actual,
    matchesSearchQuery: (entry: SearchResult, query: string) => {
      if (entry.slug.startsWith(broken.match)) throw new TypeError('cannot read the entry')
      return actual.matchesSearchQuery(entry, query)
    },
    transformToWebsiteMetadata: (entry: SearchResult) => {
      if (entry.slug.startsWith(broken.transform)) throw new TypeError('cannot read the entry')
      return actual.transformToWebsiteMetadata(entry)
    }
  }
})

/** A fresh page session: the module, and its once-per-session flag, loaded anew. */
async function pageSession() {
  vi.resetModules()
  const { reportSearchFailure, searchListings } = await import('./use-search')
  // What `useSearch` does with each debounced query.
  return (query: string) => searchListings(query).catch(reportSearchFailure)
}

function answer(status: number, body: unknown = []) {
  return Promise.resolve(Response.json(body, { status }))
}

function entry(slug: string): SearchResult {
  return {
    category: 'fixture-tools',
    description: `${slug} description.`,
    name: `Fixture ${slug}`,
    slug,
    url: `/products/${slug}/`,
    website: `https://${slug}.test/`
  }
}

const fetch = vi.fn<typeof globalThis.fetch>()

beforeEach(() => {
  logger.error.mockClear()
  fetch.mockReset()
  vi.stubGlobal('fetch', fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** No answer: the connection fails before a response, or while its body is read. */
function noAnswer(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'))
}

function cutOffAnswer(): Promise<Response> {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new TypeError('network error'))
    }
  })
  return Promise.resolve(new Response(body, { status: 200 }))
}

function reportedCauses() {
  return logger.error.mock.calls.map(([code, options]) => [
    code,
    (options as { cause: unknown }).cause?.constructor.name
  ])
}

describe('a failed search reaches Sentry at most once per kind per page session (#401)', () => {
  it('never reports an error status: the server reports its own 5xx, and a 4xx is the edge', async () => {
    const search = await pageSession()
    for (const status of [500, 502, 503, 429, 403, 401, 400]) {
      fetch.mockImplementationOnce(() => answer(status))
      await search('fixture')
    }
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports a burst of network failures and a burst of parse failures once each', async () => {
    const search = await pageSession()
    fetch.mockImplementation(noAnswer)
    for (const query of ['f', 'fi', 'fix']) await search(query)
    fetch.mockImplementation(cutOffAnswer)
    await search('fixt')
    fetch.mockImplementation(() => answer(200, { not: 'a list' }))
    await search('fixtu')
    fetch.mockImplementation(() => Promise.resolve(new Response('<html>', { status: 200 })))
    await search('fixtur')
    fetch.mockImplementation(() => answer(503))
    await search('fixture')

    expect(fetch).toHaveBeenCalledTimes(7)
    expect(reportedCauses()).toEqual([
      ['search_failed', 'TypeError'],
      ['search_failed', 'ZodError']
    ])
  })

  it('lets a later parse failure through after a flaky connection', async () => {
    const search = await pageSession()
    fetch.mockImplementationOnce(noAnswer)
    await search('fixture')
    fetch.mockImplementationOnce(() => Promise.resolve(new Response('<html>', { status: 200 })))
    await search('fixtures')
    expect(reportedCauses()).toEqual([
      ['search_failed', 'TypeError'],
      ['search_failed', 'SyntaxError']
    ])
  })

  it('keeps the error text the search box shows', async () => {
    const { searchListings } = await import('./use-search')
    fetch.mockImplementationOnce(noAnswer)
    await expect(searchListings('fixture')).rejects.toThrow('Failed to fetch')
    fetch.mockImplementationOnce(() => answer(503))
    await expect(searchListings('fixture')).rejects.toThrow('Failed to search listings: 503')
  })

  it('reports again in the next page session', async () => {
    fetch.mockImplementation(noAnswer)
    await (await pageSession())('fixture')
    await (await pageSession())('fixture')
    expect(logger.error).toHaveBeenCalledTimes(2)
  })
})

describe('a response’s failed entries are one report (#401)', () => {
  it('collapses every failed entry of a response, at any step, into one event', async () => {
    const search = await pageSession()
    const entries = [
      ...Array.from({ length: 50 }, (_, index) => entry(`${broken.match}${index}`)),
      ...Array.from({ length: 50 }, (_, index) => entry(`${broken.transform}${index}`))
    ]
    fetch.mockImplementation(() => answer(200, entries))
    await search('fixture')

    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'search_query_match_failed',
      expect.objectContaining({ cause: expect.any(TypeError) })
    )
    // Every failure stays in the console line's data, which Sentry never gets.
    const [, options] = logger.error.mock.calls[0] ?? []
    expect((options as { data: unknown[] }).data).toHaveLength(100)

    await search('fixture')
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it('reports nothing for a response whose entries all process', async () => {
    const search = await pageSession()
    fetch.mockImplementation(() => answer(200, [entry('fixture-a'), entry('fixture-b')]))
    await expect(search('fixture')).resolves.toHaveLength(2)
    expect(logger.error).not.toHaveBeenCalled()
  })
})
