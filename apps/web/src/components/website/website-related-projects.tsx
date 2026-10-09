import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getCanonicalListingListRoute } from '../../lib/routing/routes'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'

export type WebsiteRelatedProjectsProps = {
  websites: WebsiteRelatedCardMetadata[]
}

export function WebsiteRelatedProjects({ websites }: WebsiteRelatedProjectsProps) {
  if (websites.length === 0) {
    return null
  }

  return (
    <Section
      title="Related Entries"
      viewAllHref={getCanonicalListingListRoute()}
      viewAllText="Browse the directory"
      titleId="related-projects"
    >
      <LLMGrid items={websites.slice(0, 3)} analyticsSource="related-projects" />
    </Section>
  )
}
