'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logging'
import {
  SEARCH_API_PATH,
  type SearchResult,
  searchResponseSchema
} from '../../lib/directory/search-contract'
import type { SearchWebsiteMetadata } from './search-utils'
import {
  EntryFailures,
  sortEntries,
  transformAndSanitizeEntries,
  tryLenientProcessing,
  validateEntries
} from './use-search-helpers'

/**
 * A search the API answered with an error status. It isn't reported from the browser (#401): the
 * route answers only 200 or a server error, which `onRequestError` already reports (`/api` reports
 * to Sentry), and a 4xx comes from in front of it, such as a 429 throttle, a challenge or
 * staging's password.
 */
export class SearchResponseError extends Error {
  constructor(readonly status: number) {
    super(`Failed to search listings: ${status}`)
    this.name = 'SearchResponseError'
  }
}

/**
 * The failures only the browser sees: no answer arrived (`network`), or the answer didn't parse
 * or fit the contract (`parse`, such as an open tab whose code no longer matches the API).
 */
export type SearchFailureKind = 'network' | 'parse'

/** A search that failed in the browser. Keeps the original error's message, which the box shows. */
export class SearchFailure extends Error {
  constructor(
    readonly kind: SearchFailureKind,
    error: unknown
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'SearchFailure'
  }
}

function networkFailure(error: unknown): never {
  throw new SearchFailure('network', error)
}

/**
 * One search's results. Throws a `SearchResponseError` for an error status, and a `SearchFailure`
 * when no answer arrives or it doesn't parse. The entries that fail to process are dropped and
 * reported once for the response (`EntryFailures`, #401).
 */
export async function searchListings(query: string): Promise<SearchWebsiteMetadata[]> {
  const response = await fetch(`${SEARCH_API_PATH}?q=${encodeURIComponent(query)}&limit=100`).catch(
    networkFailure
  )
  if (!response.ok) throw new SearchResponseError(response.status)
  // Read, then parse: a connection lost mid-body is a network failure, not a parse failure.
  const body = await response.text().catch(networkFailure)
  try {
    return processSearchResults(searchResponseSchema.parse(JSON.parse(body)), query)
  } catch (error) {
    throw new SearchFailure('parse', error)
  }
}

function processSearchResults(
  searchResults: SearchResult[],
  query: string
): SearchWebsiteMetadata[] {
  const failures = new EntryFailures()
  try {
    const sorted = sortEntries(searchResults, query)
    const valid = validateEntries(sorted, failures)
    return valid.length === 0
      ? tryLenientProcessing(sorted, failures)
      : transformAndSanitizeEntries(valid, failures)
  } finally {
    failures.report()
  }
}

/** The kinds of failed search this page session has reported. */
const reportedSearchFailures = new Set<SearchFailureKind>()

/**
 * Whether the visitor is leaving the page (#440). Leaving cancels a search still in flight, which
 * Chromium rejects as a plain `TypeError: Failed to fetch` after `pagehide` has fired. A page the
 * back/forward cache restores (`pageshow`) is no longer leaving.
 */
let leavingPage = false
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    leavingPage = true
  })
  window.addEventListener('pageshow', () => {
    leavingPage = false
  })
}

/** A search the page abandoned, by leaving or by aborting it, rather than one that failed. */
function isAbandoned(error: SearchFailure): boolean {
  return (
    error.kind === 'network' &&
    (leavingPage || (error.cause instanceof DOMException && error.cause.name === 'AbortError'))
  )
}

/**
 * Reports a failed search at most once per kind per page session (#401). The box searches on
 * every pause in typing, so an outage would otherwise cost one Sentry event per search. Keyed by
 * kind, so a flaky connection can't hide a later parse failure. An error status isn't reported
 * (`SearchResponseError`), and neither is a search the page abandoned (#440).
 */
export function reportSearchFailure(error: unknown): void {
  if (!(error instanceof SearchFailure) || isAbandoned(error)) return
  if (reportedSearchFailures.has(error.kind)) return
  reportedSearchFailures.add(error.kind)
  logger.error('search_failed', {
    cause: error.cause,
    data: error.cause,
    tags: { type: 'component' }
  })
}

export function useSearch(query: string) {
  const [results, setResults] = useState<SearchWebsiteMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let isMounted = true
    async function fetchSearchResults() {
      if (!query) {
        setResults([])
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)

      try {
        const results = await searchListings(query)
        if (isMounted) setResults(results)
      } catch (error) {
        reportSearchFailure(error)
        if (isMounted) {
          setError(error instanceof Error ? error.message : 'An unknown error occurred')
          setResults([])
        }
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    const debounceTimer = setTimeout(fetchSearchResults, 300)
    return () => {
      isMounted = false
      clearTimeout(debounceTimer)
    }
  }, [query])

  return { results, loading, error }
}
