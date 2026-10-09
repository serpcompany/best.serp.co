import type { ComponentType, ReactNode } from 'react'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getCanonicalListingListRoute } from '../../lib/routing/routes'

type SectionProps = {
  children: ReactNode
  description?: string
  title: string
  titleId?: string
  viewAllHref?: string
  viewAllText?: string
}

type LLMGridProps = {
  analyticsSource?: string
  className?: string
  items: WebsiteRelatedCardMetadata[]
}

export type WebsiteRelatedProjectsProps = {
  websites: WebsiteRelatedCardMetadata[]
  slots: {
    LLMGrid: ComponentType<LLMGridProps>
    Section: ComponentType<SectionProps>
  }
}

export function WebsiteRelatedProjects({
  websites,
  slots: { LLMGrid, Section }
}: WebsiteRelatedProjectsProps) {
  if (websites.length === 0) {
    return null
  }

  return (
    <section className="animate-fade-in-up opacity-0 stagger-7">
      <Section
        title="Related Entries"
        viewAllHref={getCanonicalListingListRoute()}
        viewAllText="Browse the directory"
        titleId="related-projects"
      >
        <LLMGrid items={websites.slice(0, 3)} analyticsSource="related-projects" />
      </Section>
    </section>
  )
}
