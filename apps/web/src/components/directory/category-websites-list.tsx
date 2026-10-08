import type { ComponentType } from 'react'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { siteCopy } from '../../lib/site/site-copy'

type WebsitesListWithSortProps = {
  emptyDescription?: string
  emptyTitle?: string
  initialWebsites: WebsiteBrowseCardMetadata[]
}

interface CategoryWebsitesListProps {
  initialWebsites: WebsiteBrowseCardMetadata[]
  slots: {
    WebsitesListWithSort: ComponentType<WebsitesListWithSortProps>
  }
}

export function CategoryWebsitesList({ initialWebsites, slots }: CategoryWebsitesListProps) {
  const { WebsitesListWithSort } = slots

  return (
    <WebsitesListWithSort
      initialWebsites={initialWebsites}
      emptyTitle={siteCopy.categoryEmptyTitle}
      emptyDescription={siteCopy.categoryEmptyDescription}
    />
  )
}
