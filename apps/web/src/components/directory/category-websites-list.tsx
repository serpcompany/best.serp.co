'use client'

import type { ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { formatListingCount, siteCopy } from '../../lib/site/site-copy'
import { EmptyState } from './empty-state'
import { SortedListings } from './sorted-listings'

interface CategoryWebsitesListProps {
  /** The cards' `data-source`: `category`, or `tag` on a tag page. */
  analyticsSource?: string
  initialWebsites: WebsiteBrowseCardMetadata[]
  /** The toolbar's text, in place of the category's "Showing N products in this category". */
  summary?: ReactNode
}

/** A category or tag page's listings, sortable by name or newest first. */
export function CategoryWebsitesList({
  analyticsSource = 'category',
  initialWebsites,
  summary
}: CategoryWebsitesListProps) {
  return (
    <SortedListings
      listings={initialWebsites}
      analyticsSource={analyticsSource}
      summary={
        summary ??
        (initialWebsites.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Showing {formatListingCount(initialWebsites.length)} in this category
          </p>
        ) : null)
      }
      empty={
        <EmptyState
          title={siteCopy.categoryEmptyTitle}
          description={siteCopy.categoryEmptyDescription}
          actionLabel={siteCopy.submitLabel}
          actionHref={getRoute('submit')}
        />
      }
    />
  )
}
