'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logging'
import { SEARCH_API_PATH, searchResponseSchema } from '../../lib/directory/search-contract'
import type { SearchWebsiteMetadata } from './search-utils'
import {
  EntryFailures,
  filterAndSortEntries,
  transformAndSanitizeEntries,
  tryLenientProcessing,
  validateEntries
} from './use-search-helpers'

/** A search the API answered with an error status. */
export class SearchResponseError extends Error {
  constructor(readonly status: number) {
    super(`Failed to search listings: ${status}`)
    this.name = 'SearchResponseError'
  }
}

/**
 * One search's results. Throws when the request fails or its answer doesn't parse; the entries
 * that fail to process are dropped and reported once for the response (`EntryFailures`, #401).
 */
export async function searchListings(query: string): Promise<SearchWebsiteMetadata[]> {
  const response = await fetch(`${SEARCH_API_PATH}?q=${encodeURIComponent(query)}&limit=100`)
  if (!response.ok) throw new SearchResponseError(response.status)
  const searchResults = searchResponseSchema.parse(await response.json())
  const failures = new EntryFailures()
  try {
    const filtered = filterAndSortEntries(searchResults, query, failures)
    const valid = validateEntries(filtered, failures)
    return valid.length === 0
      ? tryLenientProcessing(filtered, failures)
      : transformAndSanitizeEntries(valid, failures)
  } finally {
    failures.report()
  }
}

/** Whether this page session has reported a failed search. */
let searchFailureReported = false

/**
 * Reports a failed search at most once per page session (#401). The box searches on every pause
 * in typing, so an outage would otherwise cost one Sentry event per search. A 4xx isn't reported
 * at all: the route answers only 200 or a server error, so a 4xx comes from in front of it, such
 * as a 429 throttle, a challenge or staging's password.
 */
export function reportSearchFailure(error: unknown): void {
  if (error instanceof SearchResponseError && error.status < 500) return
  if (searchFailureReported) return
  searchFailureReported = true
  logger.error('search_failed', {
    cause: error,
    data: error,
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
