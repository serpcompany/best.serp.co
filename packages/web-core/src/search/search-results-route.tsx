'use client'

import { useSearchParams } from 'next/navigation'
import { EmptyState } from '../empty-state'
import { WebsitesListWithSortRoute } from '../websites-list-with-sort-route'
import { SearchFilters } from './search-filters'
import { SearchResults as SharedSearchResults } from './search-results'
import { useSearch } from './use-search'

export function SearchResultsRoute() {
  const searchParams = useSearchParams()
  const query = searchParams.get('q') || ''
  const { results, loading, error } = useSearch(query)

  return (
    <SharedSearchResults
      query={query}
      results={results}
      loading={loading}
      error={error}
      slots={{
        EmptyState,
        SearchFilters,
        WebsitesListWithSort: WebsitesListWithSortRoute,
      }}
    />
  )
}
