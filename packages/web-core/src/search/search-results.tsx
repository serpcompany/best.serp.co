'use client'

import { type ComponentType, useEffect, useMemo, useState } from 'react'
import { getCategoryDisplayName } from '../category-display'
import type { WebsiteBrowseCardMetadata } from '../content-query'
import { getRoute } from '../routes'
import { siteConfig } from '../site-config'
import { siteCopy } from '../site-copy'

type EmptyStateProps = {
  actionHref?: string
  actionLabel?: string
  description: string
  onAction?: () => void
  title: string
}

type SearchFiltersProps = {
  availableCategories: string[]
  onCategoryChange: (categories: string[]) => void
  resultCount: number
  selectedCategories: string[]
}

type WebsitesListWithSortProps = {
  emptyDescription?: string
  emptyTitle?: string
  initialWebsites: WebsiteBrowseCardMetadata[]
}

export interface SearchResultsViewProps {
  error: string | null
  loading: boolean
  query: string
  results: WebsiteBrowseCardMetadata[]
  slots: {
    EmptyState: ComponentType<EmptyStateProps>
    SearchFilters: ComponentType<SearchFiltersProps>
    WebsitesListWithSort: ComponentType<WebsitesListWithSortProps>
  }
}

export function SearchResults({ error, loading, query, results, slots }: SearchResultsViewProps) {
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const { EmptyState, SearchFilters, WebsitesListWithSort } = slots

  const filteredResults = useMemo(() => {
    if (selectedCategories.length === 0) {
      return results
    }
    return results.filter(result =>
      (result.categories || []).some(category => selectedCategories.includes(category))
    )
  }, [results, selectedCategories])

  const availableCategories = useMemo(
    () => results.flatMap(result => result.categories || []),
    [results]
  )
  const availableCategoryCount = useMemo(
    () => new Set(availableCategories).size,
    [availableCategories]
  )

  useEffect(() => {
    if (query) {
      document.title = `Search Results for "${query}" | ${siteConfig.name}`
    } else {
      document.title = `Search | ${siteConfig.name}`
    }
  }, [query])

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
        <h2 className="text-lg font-semibold text-red-800 dark:text-red-400">
          Something went wrong
        </h2>
        <p className="mt-1 text-red-700 dark:text-red-300">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 rounded-md bg-red-100 px-4 py-2 text-red-800 transition-colors hover:bg-red-200 dark:bg-red-800 dark:text-red-200 dark:hover:bg-red-700"
        >
          Refresh Page
        </button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-t-2 border-primary-500" />
      </div>
    )
  }

  if (!query) {
    return (
      <EmptyState
        title="Start Your Search"
        description={`Type something in the search bar above to find ${siteCopy.listingName.plural} and resources.`}
        actionLabel={siteCopy.exploreAllLabel}
        actionHref={getRoute('home')}
      />
    )
  }

  if (results.length === 0) {
    return (
      <div className="space-y-6">
        <div className="py-8 text-center">
          <h2 className="mb-2 text-xl font-semibold">Nothing Found</h2>
          <p className="mb-6 text-muted-foreground">
            We couldn't find any results for "{query}". Try using different keywords or check your
            spelling.
          </p>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Search suggestions:</p>
            <ul className="mx-auto max-w-md list-inside list-disc space-y-1">
              <li>Check for typos in your search terms</li>
              <li>Try more general keywords (e.g., "AI" instead of "artificial intelligence")</li>
              <li>Browse by category using the sidebar</li>
              <li>Submit a new {siteCopy.listingName.singular} if you do not see it listed</li>
            </ul>
          </div>
        </div>
        <EmptyState
          title={siteCopy.submitLabel}
          description={`Don't see your ${siteCopy.listingName.singular} listed? Submit a ${siteCopy.listingName.singular} to be included in ${siteConfig.name}.`}
          actionLabel={siteCopy.submitLabel}
          actionHref={getRoute('submit')}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {filteredResults.length} result
              {filteredResults.length !== 1 ? 's' : ''} for "{query}"
            </h2>
            <p className="text-sm text-muted-foreground">
              {selectedCategories.length > 0 ? (
                <>
                  Filtered by {selectedCategories.length} categor
                  {selectedCategories.length !== 1 ? 'ies' : 'y'}
                  {results.length !== filteredResults.length ? (
                    <> • {results.length} total results</>
                  ) : null}
                </>
              ) : (
                <>
                  Found in {availableCategoryCount} categor
                  {availableCategoryCount !== 1 ? 'ies' : 'y'}
                </>
              )}
            </p>
          </div>

          <SearchFilters
            selectedCategories={selectedCategories}
            onCategoryChange={setSelectedCategories}
            availableCategories={availableCategories}
            resultCount={results.length}
          />
        </div>
      </div>

      {results.length > 3 && selectedCategories.length === 0 ? (
        <div className="rounded-lg border bg-muted/20 p-4">
          <h3 className="mb-3 text-sm font-semibold">Results by category:</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(
              results.reduce<Record<string, number>>((acc, result) => {
                for (const category of result.categories || []) {
                  acc[category] = (acc[category] || 0) + 1
                }
                return acc
              }, {})
            ).map(([category, count]) => (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategories([category])}
                className="inline-flex items-center rounded-full border bg-background px-3 py-1 text-xs transition-colors hover:bg-muted/50"
              >
                {getCategoryDisplayName(category)} ({count})
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {filteredResults.length === 0 && selectedCategories.length > 0 ? (
        <div className="py-8 text-center">
          <h3 className="mb-2 text-lg font-semibold">No results match your filters</h3>
          <p className="mb-4 text-muted-foreground">
            Try removing some category filters or search with different terms.
          </p>
          <button
            type="button"
            onClick={() => setSelectedCategories([])}
            className="text-sm font-medium text-primary hover:text-primary/80"
          >
            Clear all filters
          </button>
        </div>
      ) : (
        <WebsitesListWithSort
          initialWebsites={filteredResults}
          emptyTitle="No results found"
          emptyDescription={`We couldn't find any results for "${query}". Try using different keywords or check your spelling.`}
        />
      )}
    </div>
  )
}
