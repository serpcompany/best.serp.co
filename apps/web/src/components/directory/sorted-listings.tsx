'use client'

import { type ReactNode, useMemo } from 'react'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { useAnalyticsEvents } from '../layout/root-shell-client'
import { Toolbar } from '../layout/toolbar'
import { LLMGrid } from '../llm/llm-grid'
import { ListingSortToggle, sortListings, useStoredListingSort } from './listing-sort'

interface SortedListingsProps {
  /** More controls, before the sort. */
  actions?: ReactNode
  /** The listing cards' `data-source`, and with `-sort` the sort event's source. */
  analyticsSource: string
  /** Shown in place of the grid when there are no listings. */
  empty: ReactNode
  listings: WebsiteBrowseCardMetadata[]
  /** Between the toolbar and the grid. */
  notice?: ReactNode
  /** The toolbar's leading text. */
  summary?: ReactNode
}

/**
 * A page of listings in the shared card grid (#268): a `Toolbar` with a summary and the sort,
 * then the serp.co-style listing cards in one, two, then three columns.
 */
export function SortedListings({
  actions,
  analyticsSource,
  empty,
  listings,
  notice,
  summary
}: SortedListingsProps) {
  const { trackSortChange } = useAnalyticsEvents()
  // The key the category list has always used, so a visitor's choice carries over.
  const [sort, setSort] = useStoredListingSort('category-sort-by')
  const sortedListings = useMemo(() => sortListings(listings, sort), [listings, sort])

  return (
    <div className="flex flex-col gap-6">
      <Toolbar className="justify-between sm:items-center">
        <div className="min-w-0">{summary}</div>
        <div className="flex flex-wrap items-center gap-3">
          {actions}
          <ListingSortToggle
            value={sort}
            onValueChange={next => {
              trackSortChange(sort, next, `${analyticsSource}-sort`)
              setSort(next)
            }}
          />
        </div>
      </Toolbar>
      {notice}
      {sortedListings.length > 0 ? (
        <LLMGrid items={sortedListings} analyticsSource={analyticsSource} />
      ) : (
        empty
      )}
    </div>
  )
}
