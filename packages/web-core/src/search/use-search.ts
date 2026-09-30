'use client'

import { logger } from '@serpdirectory/logging'
import { useEffect, useState } from 'react'
import { SEARCH_API_PATH, searchResponseSchema } from '../search-contract'
import type { SearchWebsiteMetadata } from './search-utils'
import {
  filterAndSortEntries,
  transformAndSanitizeEntries,
  tryLenientProcessing,
  validateEntries
} from './use-search-helpers'

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
        const response = await fetch(`${SEARCH_API_PATH}?q=${encodeURIComponent(query)}&limit=100`)
        if (!response.ok) throw new Error(`Failed to search listings: ${response.status}`)
        const searchResults = searchResponseSchema.parse(await response.json())
        const filtered = filterAndSortEntries(searchResults, query)
        const valid = validateEntries(filtered)

        if (valid.length === 0) {
          const lenientResults = tryLenientProcessing(filtered)
          if (isMounted) setResults(lenientResults)
          return
        }

        const results = transformAndSanitizeEntries(valid)
        if (isMounted) setResults(results)
      } catch (error) {
        logger.error('Error fetching or processing search results:', {
          data: error,
          tags: { type: 'component' }
        })
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
