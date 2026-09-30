import type { ComponentType, ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata, WebsiteRelatedCardMetadata } from '../content-query'

type SectionProps = {
  title: string
  description?: string
  children: ReactNode
  viewAllHref?: string
  viewAllText?: string
  titleId?: string
}

type LLMGridProps = {
  items: WebsiteRelatedCardMetadata[]
}

interface FeaturedProjectsSectionProps {
  projects: WebsiteBrowseCardMetadata[]
  slots: {
    LLMGrid: ComponentType<LLMGridProps>
    Section: ComponentType<SectionProps>
  }
}

export function FeaturedProjectsSection({
  projects,
  slots: { LLMGrid, Section }
}: FeaturedProjectsSectionProps) {
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
