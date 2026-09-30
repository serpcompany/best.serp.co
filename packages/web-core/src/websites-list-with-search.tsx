'use client'

import { useEffect, useMemo, useState } from 'react'
import type { WebsiteBrowseCardMetadata, WebsiteRelatedCardMetadata } from './content-query'
import { getRoute } from './routes'
import { siteCopy } from './site-copy'

type SortBy = 'name' | 'latest'

type EmptyStateProps = {
  actionHref?: string
  actionLabel?: string
  description: string
  onAction?: () => void
  title: string
}

type WebsitesSearchControlsProps = {
  filteredCount: number
  hasFavorites: boolean
  searchQuery: string
  setSearchQuery: (query: string) => void
  setShowFavoritesOnly: (show: boolean) => void
  setSortBy: (sort: SortBy) => void
  showFavoritesOnly: boolean
  sortBy: SortBy
  trackSearch: (query: string, count: number, source: string) => void
  trackSortChange: (from: string, to: string, source: string) => void
}

type LLMGridProps = {
  animateIn?: boolean
  className?: string
  items: WebsiteRelatedCardMetadata[]
  maxItems?: number
}

type WebsitesListWithSearchProps = {
  analytics: {
    trackSearch: (query: string, count: number, source: string) => void
    trackSortChange: (from: string, to: string, source: string) => void
  }
  displayLimit?: number
  emptyDescription?: string
  emptyTitle?: string
  favorites: {
    favoriteWebsites: WebsiteBrowseCardMetadata[]
    hasFavorites: boolean
  }
  initialShowFavoritesOnly?: boolean
  initialWebsites: WebsiteBrowseCardMetadata[]
  slots: {
    EmptyState: React.ComponentType<EmptyStateProps>
    LLMGrid: React.ComponentType<LLMGridProps>
    WebsitesSearchControls: React.ComponentType<WebsitesSearchControlsProps>
  }
  totalCount?: number
}

export function WebsitesListWithSearch({
  analytics,
  displayLimit,
  emptyDescription = `There are no directory entries available. Try checking back later or ${siteCopy.submitLabelSentence}.`,
  emptyTitle = 'No entries found',
  favorites,
  initialShowFavoritesOnly = false,
  initialWebsites,
  slots,
  totalCount
}: WebsitesListWithSearchProps) {
  const [sortBy, setSortBy] = useState<SortBy>('latest')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(initialShowFavoritesOnly)
  const [isClient, setIsClient] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [allWebsites] = useState<WebsiteBrowseCardMetadata[]>(initialWebsites)
  const { trackSearch, trackSortChange } = analytics
  const { favoriteWebsites, hasFavorites } = favorites
  const { EmptyState, LLMGrid, WebsitesSearchControls } = slots

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

    if (sortBy === 'latest') {
      return websites.sort((a, b) => {
        const dateA = new Date(a.publishedAt).getTime()
        const dateB = new Date(b.publishedAt).getTime()
        return dateB - dateA
      })
    }

    return websites.sort((a, b) => a.name.localeCompare(b.name))
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
              <LLMGrid
                items={filteredAndSortedWebsites}
                maxItems={displayLimit}
                animateIn={!searchQuery.trim() && !isLoading}
                className="transition-all duration-500 ease-in-out"
              />
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
