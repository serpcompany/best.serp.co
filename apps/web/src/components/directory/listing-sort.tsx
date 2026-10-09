'use client'

import { Clock, SortAsc } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export type ListingSort = 'name' | 'latest'

interface SortableListing {
  name: string
  publishedAt: string
}

function isListingSort(value: unknown): value is ListingSort {
  return value === 'name' || value === 'latest'
}

/** Listings by name, or newest first. */
export function sortListings<T extends SortableListing>(
  listings: readonly T[],
  sort: ListingSort
): T[] {
  const sorted = [...listings]
  if (sort === 'latest') {
    return sorted.sort(
      (left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime()
    )
  }
  return sorted.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * A sort choice remembered in `localStorage` under `key`. The server renders `initial`; the saved
 * choice applies after hydration.
 */
export function useStoredListingSort(key: string, initial: ListingSort = 'name') {
  const [sort, setSort] = useState<ListingSort>(initial)

  useEffect(() => {
    const saved = localStorage.getItem(key)
    if (isListingSort(saved)) setSort(saved)
  }, [key])

  const chooseSort = (next: ListingSort) => {
    setSort(next)
    localStorage.setItem(key, next)
  }

  return [sort, chooseSort] as const
}

interface ListingSortToggleProps {
  onValueChange: (sort: ListingSort) => void
  value: ListingSort
}

/** The "Sort by" control over a list of listings: by name, or newest first. */
export function ListingSortToggle({ onValueChange, value }: ListingSortToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Sort by:</span>
      <ToggleGroup
        value={[value]}
        onValueChange={([next]: string[]) => {
          if (isListingSort(next) && next !== value) onValueChange(next)
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
  )
}
