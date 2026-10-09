'use client'

import { Clock, Heart, SortAsc } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { getRoute } from '../../lib/routing/routes'
import { SearchInput } from '../search/search-input'

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
    <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
      <form
        onSubmit={event => {
          event.preventDefault()
          if (searchQuery.trim()) {
            trackSearch(searchQuery, filteredCount, 'homepage-search')
            router.push(`${getRoute('search')}?q=${encodeURIComponent(searchQuery)}`)
          }
        }}
        className="relative flex-1 max-w-md"
      >
        <SearchInput
          placeholder="Search the directory..."
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          searchButtonClassName="px-2 hover:text-muted-foreground"
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
            {showFavoritesOnly ? 'Show All' : 'Favorites Only'}
          </Toggle>
        )}

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort by:</span>
          <ToggleGroup
            value={[sortBy]}
            onValueChange={([value]: string[]) => {
              if (value && value !== sortBy) {
                trackSortChange(sortBy, value, 'homepage-sort')
                setSortBy(value as 'name' | 'latest')
              }
            }}
            variant="outline"
          >
            <ToggleGroupItem value="name">
              <SortAsc />
              Name
            </ToggleGroupItem>
            <ToggleGroupItem value="latest">
              <Clock />
              Latest
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
    </div>
  )
}
