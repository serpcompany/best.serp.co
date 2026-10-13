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

describe('a failed search reaches Sentry at most once per page session (#401)', () => {
  it('reports a burst against a failing API once', async () => {
    const search = await pageSession()
    fetch.mockImplementation(() => answer(503))
    for (const query of ['f', 'fi', 'fix', 'fixt', 'fixture']) await search(query)
    fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    for (const query of ['fixture t', 'fixture to']) await search(query)
    fetch.mockImplementation(() => answer(200, { not: 'a list' }))
    await search('fixture too')

    expect(fetch).toHaveBeenCalledTimes(8)
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'search_failed',
      expect.objectContaining({ cause: expect.objectContaining({ status: 503 }) })
    )
  })

  it('never reports a throttle or another 4xx, and still reports the next real failure', async () => {
    const search = await pageSession()
    for (const status of [429, 429, 429, 403, 401, 400]) {
      fetch.mockImplementationOnce(() => answer(status))
      await search('fixture')
    }
    expect(logger.error).not.toHaveBeenCalled()

    fetch.mockImplementation(() => answer(500))
    await search('fixture')
    await search('fixtures')
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('search_failed', expect.anything())
  })

  it('reports again in the next page session', async () => {
    fetch.mockImplementation(() => answer(502))
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
