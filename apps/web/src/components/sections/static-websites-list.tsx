import type { ComponentType, ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { siteCopy } from '../../lib/site/site-copy'

type SectionProps = {
  title: string
  description?: string
  children: ReactNode
  viewAllHref?: string
  viewAllText?: string
  titleId?: string
}

type WebsitesListWithSearchProps = {
  initialWebsites: WebsiteBrowseCardMetadata[]
  totalCount?: number
  displayLimit?: number
  emptyTitle?: string
  emptyDescription?: string
}

interface StaticWebsitesListProps {
  websites: WebsiteBrowseCardMetadata[]
  totalCount?: number
  displayLimit?: number
  /** Crawlable page links rendered under the list. */
  pagination?: ReactNode
  slots: {
    Section: ComponentType<SectionProps>
    WebsitesListWithSearch: ComponentType<WebsitesListWithSearchProps>
  }
}

export function StaticWebsitesList({
  websites,
  totalCount,
  displayLimit,
  pagination,
  slots: { Section, WebsitesListWithSearch }
}: StaticWebsitesListProps) {
  return (
    <Section
      title="Browse the Directory"
      description="Explore the complete directory and search by name, category, or description."
      titleId={siteCopy.allAnchorId}
    >
      <WebsitesListWithSearch
        initialWebsites={websites}
        totalCount={totalCount}
        displayLimit={displayLimit}
        emptyTitle="No entries found"
        emptyDescription={`There are no directory entries available. Try checking back later or ${siteCopy.submitLabel.toLowerCase()}.`}
      />
      {pagination}
    </Section>
  )
}
