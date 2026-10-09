import type { ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { siteCopy } from '../../lib/site/site-copy'
import { WebsitesListWithSearch } from '../directory/websites-list-with-search'
import { Section } from '../layout/section'

interface StaticWebsitesListProps {
  websites: WebsiteBrowseCardMetadata[]
  totalCount?: number
  displayLimit?: number
  /** Crawlable page links rendered under the list. */
  pagination?: ReactNode
}

export function StaticWebsitesList({
  websites,
  totalCount,
  displayLimit,
  pagination
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
