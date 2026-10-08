'use client'

import { useFavoritesFilter } from '../../hooks/use-favorites-filter'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { useAnalyticsEvents } from '../layout/root-shell-client'
import { LLMGrid } from '../llm/llm-grid'
import { EmptyState } from './empty-state'
import { WebsitesListWithSearch as SharedWebsitesListWithSearch } from './websites-list-with-search'
import { WebsitesSearchControls } from './websites-search-controls'

interface WebsitesListWithSearchRouteProps {
  initialWebsites: WebsiteBrowseCardMetadata[]
  emptyTitle?: string
  emptyDescription?: string
  initialShowFavoritesOnly?: boolean
  totalCount?: number
  displayLimit?: number
}

export function WebsitesListWithSearchRoute(props: WebsitesListWithSearchRouteProps) {
  const analytics = useAnalyticsEvents()
  const favorites = useFavoritesFilter(props.initialWebsites)

  return (
    <SharedWebsitesListWithSearch
      {...props}
      analytics={analytics}
      favorites={favorites}
      slots={{
        EmptyState,
        LLMGrid,
        WebsitesSearchControls
      }}
    />
  )
}
