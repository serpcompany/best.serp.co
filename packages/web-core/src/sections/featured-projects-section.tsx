import type { ComponentType, ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata, WebsiteRelatedCardMetadata } from '../content-query'
import { getFeaturedCategoryRoute } from '../routes'

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
  const hasFeaturedListings = projects.some(project => project.featured === true)

  return (
    <Section
      title="Featured Listings"
      description="Discover standout listings from this directory"
      titleId="featured"
      viewAllHref={hasFeaturedListings ? getFeaturedCategoryRoute() : undefined}
      viewAllText={hasFeaturedListings ? 'All featured' : undefined}
    >
      {projects.length > 0 && <LLMGrid items={projects} />}
    </Section>
  )
}
