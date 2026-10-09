'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFavoritesFilter } from '../../hooks/use-favorites-filter'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { siteCopy } from '../../lib/site/site-copy'
import { useAnalyticsEvents } from '../layout/root-shell-client'
import { LLMGrid } from '../llm/llm-grid'
import { EmptyState } from './empty-state'
import { type ListingSort as SortBy, sortListings } from './listing-sort'
import { WebsitesSearchControls } from './websites-search-controls'

interface WebsitesListWithSearchProps {
  displayLimit?: number
  emptyDescription?: string
  emptyTitle?: string
  initialShowFavoritesOnly?: boolean
  initialWebsites: WebsiteBrowseCardMetadata[]
  totalCount?: number
}

export function WebsitesListWithSearch({
  displayLimit,
  emptyDescription = `There are no directory entries available. Try checking back later or ${siteCopy.submitLabelSentence}.`,
  emptyTitle = 'No entries found',
  initialShowFavoritesOnly = false,
  initialWebsites,
  totalCount
}: WebsitesListWithSearchProps) {
  const [sortBy, setSortBy] = useState<SortBy>('latest')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(initialShowFavoritesOnly)
  const [isClient, setIsClient] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [allWebsites] = useState<WebsiteBrowseCardMetadata[]>(initialWebsites)
  const { trackSearch, trackSortChange } = useAnalyticsEvents()
  const { favoriteWebsites, hasFavorites } = useFavoritesFilter(initialWebsites)

  useEffect(() => {
    requestAnimationFrame(() => {
      const savedSortBy = localStorage.getItem('websites-sort-by')

      if (savedSortBy !== null) {
        const parsedSortBy = JSON.parse(savedSortBy)
        if (parsedSortBy === 'name' || parsedSortBy === 'latest') {
          setSortBy(parsedSortBy)
        }
      }

      setIsClient(true)
      setIsLoading(false)
    })
  }, [])

  useEffect(() => {
    if (isClient) {
      localStorage.setItem('websites-sort-by', JSON.stringify(sortBy))
    }
  }, [sortBy, isClient])

  const filteredAndSortedWebsites = useMemo(() => {
    let websites = showFavoritesOnly ? [...favoriteWebsites] : [...allWebsites]
    const normalizedQuery = searchQuery.trim().toLowerCase()

    if (normalizedQuery) {
      websites = websites.filter(website => {
        const searchableText = `${website.name} ${website.description} ${
          website.category
        } ${(website.categories || []).join(' ')}`.toLowerCase()
        return searchableText.includes(normalizedQuery)
      })
    }

    return sortListings(websites, sortBy)
  }, [allWebsites, favoriteWebsites, searchQuery, showFavoritesOnly, sortBy])

  if (!initialWebsites.length) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        actionLabel={siteCopy.submitLabel}
        actionHref={getRoute('submit')}
      />
    )
  }

  return (
    <div className="space-y-6">
      <WebsitesSearchControls
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        sortBy={sortBy}
        setSortBy={setSortBy}
        showFavoritesOnly={showFavoritesOnly}
        setShowFavoritesOnly={setShowFavoritesOnly}
        hasFavorites={hasFavorites}
        filteredCount={filteredAndSortedWebsites.length}
        trackSearch={trackSearch}
        trackSortChange={trackSortChange}
      />

      {filteredAndSortedWebsites.length === 0 ? (
        searchQuery.trim() ? (
          <EmptyState
            title="No results found"
            description={`No entries found matching "${searchQuery}". Try a different search term.`}
            actionLabel="Clear Search"
            onAction={() => setSearchQuery('')}
          />
        ) : (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        )
      ) : (
        <div>
          <h2 className="sr-only mb-6 text-2xl font-semibold">
            {siteCopy.listingName.pluralTitle}
          </h2>
          {searchQuery ? (
            <p className="mb-4 text-sm text-muted-foreground">
              Showing {filteredAndSortedWebsites.length} result
              {filteredAndSortedWebsites.length !== 1 ? 's' : ''} for "{searchQuery}"
            </p>
          ) : null}

          <div className="relative">
            <div
              className={`transition-opacity duration-300 ${
                isLoading ? 'opacity-80' : 'opacity-100'
              }`}
            >
              <LLMGrid items={filteredAndSortedWebsites} maxItems={displayLimit} />
            </div>
          </div>

          <div className="mt-8 text-center" aria-live="polite">
            <div className="text-sm text-muted-foreground">
              <p>
                Showing{' '}
                {Math.min(
                  filteredAndSortedWebsites.length,
                  displayLimit ?? filteredAndSortedWebsites.length
                )}{' '}
                of {filteredAndSortedWebsites.length} matching {siteCopy.listingName.plural}.
              </p>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Directory size: {totalCount || allWebsites.length} {siteCopy.listingName.plural}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
