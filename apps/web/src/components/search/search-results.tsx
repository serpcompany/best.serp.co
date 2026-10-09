'use client'

import { type ComponentType, useEffect, useMemo, useState } from 'react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { SortedListings } from '../directory/sorted-listings'

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

export interface SearchResultsViewProps {
  error: string | null
  loading: boolean
  query: string
  results: WebsiteBrowseCardMetadata[]
  slots: {
    EmptyState: ComponentType<EmptyStateProps>
    SearchFilters: ComponentType<SearchFiltersProps>
  }
}

export function SearchResults({ error, loading, query, results, slots }: SearchResultsViewProps) {
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const { EmptyState, SearchFilters } = slots

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
      <Alert variant="destructive">
        <AlertTitle>
          <h2>Something went wrong</h2>
        </AlertTitle>
        <AlertDescription>{error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Refresh Page
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-8" />
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

  const resultCategoryCounts = Object.entries(
    results.reduce<Record<string, number>>((counts, result) => {
      for (const category of result.categories || []) {
        counts[category] = (counts[category] || 0) + 1
      }
      return counts
    }, {})
  )

  return (
    <SortedListings
      listings={filteredResults}
      analyticsSource="search"
      summary={
        <>
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
        </>
      }
      actions={
        <SearchFilters
          selectedCategories={selectedCategories}
          onCategoryChange={setSelectedCategories}
          availableCategories={availableCategories}
          resultCount={results.length}
        />
      }
      notice={
        results.length > 3 && selectedCategories.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Results by category:</h3>
            {resultCategoryCounts.map(([category, count]) => (
              <Button
                key={category}
                variant="secondary"
                size="sm"
                onClick={() => setSelectedCategories([category])}
              >
                {getCategoryDisplayName(category)} ({count})
              </Button>
            ))}
          </div>
        ) : null
      }
      empty={
        <div className="py-8 text-center">
          <h3 className="mb-2 text-lg font-semibold">No results match your filters</h3>
          <p className="mb-4 text-muted-foreground">
            Try removing some category filters or search with different terms.
          </p>
          <Button variant="link" onClick={() => setSelectedCategories([])}>
            Clear all filters
          </Button>
        </div>
      }
    />
  )
}
