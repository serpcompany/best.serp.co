import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getCanonicalListingListRoute } from '../../lib/routing/routes'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'

export type WebsiteRelatedProjectsProps = {
  websites: WebsiteRelatedCardMetadata[]
}

/**
 * A listing page's Alternatives section (#519), in the look "Related Entries" had: every
 * alternative the catalog read returns (at most six), its hand picks first, then similar listings.
 */
export function WebsiteRelatedProjects({ websites }: WebsiteRelatedProjectsProps) {
  if (websites.length === 0) {
    return null
  }

  return (
    <Section
      title="Alternatives"
      viewAllHref={getCanonicalListingListRoute()}
      viewAllText="Browse the directory"
      titleId="alternatives"
    >
      <LLMGrid items={websites} analyticsSource="related-projects" />
    </Section>
  )
}
