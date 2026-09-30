import { CategoryWebsitesList as SharedCategoryWebsitesList } from './category-websites-list'
import type { WebsiteBrowseCardMetadata } from './content-query'
import { WebsitesListWithSortRoute } from './websites-list-with-sort-route'

interface CategoryWebsitesListRouteProps {
  initialWebsites: WebsiteBrowseCardMetadata[]
}

export function CategoryWebsitesListRoute({ initialWebsites }: CategoryWebsitesListRouteProps) {
  return (
    <SharedCategoryWebsitesList
      initialWebsites={initialWebsites}
      slots={{ WebsitesListWithSort: WebsitesListWithSortRoute }}
    />
  )
}
