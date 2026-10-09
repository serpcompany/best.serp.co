import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'

interface FeaturedProjectsSectionProps {
  projects: WebsiteBrowseCardMetadata[]
}

export function FeaturedProjectsSection({ projects }: FeaturedProjectsSectionProps) {
  return (
    <Section
      title="Featured Listings"
      description="Discover standout listings from this directory"
      titleId="featured"
    >
      {projects.length > 0 && <LLMGrid items={projects} />}
    </Section>
  )
}
