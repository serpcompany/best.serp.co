import type { ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { WebsitesListWithSearchRoute } from '../directory/websites-list-with-search-route'
import { Section } from '../layout/section'
import { StaticWebsitesList as SharedStaticWebsitesList } from './static-websites-list'

interface StaticWebsitesListRouteProps {
  websites: WebsiteBrowseCardMetadata[]
  totalCount?: number
  displayLimit?: number
  pagination?: ReactNode
}

export function StaticWebsitesListRoute({
  websites,
  totalCount,
  displayLimit,
  pagination
}: StaticWebsitesListRouteProps) {
  return (
    <SharedStaticWebsitesList
      websites={websites}
      totalCount={totalCount}
      displayLimit={displayLimit}
      pagination={pagination}
      slots={{
        Section,
        WebsitesListWithSearch: WebsitesListWithSearchRoute
      }}
    />
  )
}
