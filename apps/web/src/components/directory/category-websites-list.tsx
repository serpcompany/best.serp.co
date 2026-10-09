'use client'

import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { siteCopy } from '../../lib/site/site-copy'
import { EmptyState } from './empty-state'
import { SortedListings } from './sorted-listings'

interface CategoryWebsitesListProps {
  initialWebsites: WebsiteBrowseCardMetadata[]
}

/** A category page's listings, sortable by name or newest first. */
export function CategoryWebsitesList({ initialWebsites }: CategoryWebsitesListProps) {
  return (
    <SortedListings
      listings={initialWebsites}
      analyticsSource="category"
      summary={
        initialWebsites.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Showing {initialWebsites.length} {siteCopy.listingName.plural} in this category
          </p>
        ) : null
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
