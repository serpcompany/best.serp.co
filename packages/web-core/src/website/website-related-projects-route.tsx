import type { WebsiteRelatedCardMetadata } from '../content-query'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'
import { WebsiteRelatedProjects as SharedWebsiteRelatedProjects } from './website-related-projects'

interface WebsiteRelatedProjectsRouteProps {
  websites: WebsiteRelatedCardMetadata[]
}

export function WebsiteRelatedProjectsRoute({ websites }: WebsiteRelatedProjectsRouteProps) {
  return <SharedWebsiteRelatedProjects websites={websites} slots={{ LLMGrid, Section }} />
}
