import type { WebsiteBrowseCardMetadata } from '../content-query'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'
import { FeaturedProjectsSection as SharedFeaturedProjectsSection } from './featured-projects-section'

interface FeaturedProjectsSectionRouteProps {
  projects: WebsiteBrowseCardMetadata[]
}

export function FeaturedProjectsSectionRoute({ projects }: FeaturedProjectsSectionRouteProps) {
  return <SharedFeaturedProjectsSection projects={projects} slots={{ LLMGrid, Section }} />
}
