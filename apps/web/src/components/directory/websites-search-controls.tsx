'use client'

import { Heart } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Toggle } from '@/components/ui/toggle'
import { getRoute } from '../../lib/routing/routes'
import { SearchField } from '../layout/search-field'
import { Toolbar } from '../layout/toolbar'
import { ListingSortToggle } from './listing-sort'

interface WebsitesSearchControlsProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  sortBy: 'name' | 'latest'
  setSortBy: (sort: 'name' | 'latest') => void
  showFavoritesOnly: boolean
  setShowFavoritesOnly: (show: boolean) => void
  hasFavorites: boolean
  filteredCount: number
  trackSearch: (query: string, count: number, source: string) => void
  trackSortChange: (from: string, to: string, source: string) => void
}

export function WebsitesSearchControls({
  searchQuery,
  setSearchQuery,
  sortBy,
  setSortBy,
  showFavoritesOnly,
  setShowFavoritesOnly,
  hasFavorites,
  filteredCount,
  trackSearch,
  trackSortChange
}: WebsitesSearchControlsProps) {
  const router = useRouter()

  return (
    <Toolbar className="justify-between">
      <form
        onSubmit={event => {
          event.preventDefault()
          if (searchQuery.trim()) {
            trackSearch(searchQuery, filteredCount, 'homepage-search')
            router.push(`${getRoute('search')}?q=${encodeURIComponent(searchQuery)}`)
          }
        }}
        className="w-full max-w-md"
      >
        <SearchField
          name="q"
          autoComplete="off"
          aria-label="Search"
          submitLabel="Search"
          placeholder="Search the directory..."
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
        />
      </form>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        {hasFavorites && (
          <Toggle
            variant="outline"
            pressed={showFavoritesOnly}
            onPressedChange={setShowFavoritesOnly}
          >
            <Heart
              className={showFavoritesOnly ? 'fill-destructive text-destructive' : undefined}
            />
            Favorites Only
          </Toggle>
        )}

        <ListingSortToggle
          value={sortBy}
          onValueChange={next => {
            trackSortChange(sortBy, next, 'homepage-sort')
            setSortBy(next)
          }}
        />
      </div>
    </Toolbar>
  )
}
