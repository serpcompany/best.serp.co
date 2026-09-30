'use client'

import { Badge } from '@serpdirectory/design-system/badge'
import { ToggleGroup, ToggleGroupItem } from '@serpdirectory/design-system/toggle-group'
import type { WebsiteBrowseCardMetadata } from './content-query'
import { EmptyState } from './empty-state'
import { useAnalyticsEvents } from './root-shell-client'
import { siteCopy } from './site-copy'
import { Card } from './ui/card'
import { FaviconWithFallback } from './ui/favicon-with-fallback'
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
        FaviconWithFallback,
        ToggleGroup,
        ToggleGroupItem
      }}
    />
  )
}
