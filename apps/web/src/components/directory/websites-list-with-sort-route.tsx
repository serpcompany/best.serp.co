'use client'

import { Badge } from '@serpdirectory/design-system/badge'
import { ToggleGroup, ToggleGroupItem } from '@serpdirectory/design-system/toggle-group'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { EmptyState } from './empty-state'
import { useAnalyticsEvents } from '../layout/root-shell-client'
import { siteCopy } from '../../lib/site/site-copy'
import { Card } from '../ui/card'
import { ListingImage } from '../ui/listing-image'
import { WebsitesListWithSort as SharedWebsitesListWithSort } from './websites-list-with-sort'

interface WebsitesListWithSortRouteProps {
  initialWebsites: WebsiteBrowseCardMetadata[]
  emptyTitle?: string
  emptyDescription?: string
}

export function WebsitesListWithSortRoute({
  initialWebsites,
  emptyTitle = siteCopy.categoryEmptyTitle,
  emptyDescription = siteCopy.categoryEmptyDescription
}: WebsitesListWithSortRouteProps) {
  const { trackSortChange } = useAnalyticsEvents()

  return (
    <SharedWebsitesListWithSort
      initialWebsites={initialWebsites}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      trackSortChange={trackSortChange}
      slots={{
        Badge,
        EmptyState,
        Card,
        ListingImage,
        ToggleGroup,
        ToggleGroupItem
      }}
    />
  )
}
