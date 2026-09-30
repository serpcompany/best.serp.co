import type { ComponentType, ReactNode } from 'react'
import type { WebsiteRelatedCardMetadata } from '../content-query'
import { getCanonicalListingListRoute } from '../routes'

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
  animateIn?: boolean
  className?: string
  items: WebsiteRelatedCardMetadata[]
  overrideGrid?: boolean
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
        <LLMGrid
          items={websites.slice(0, 3)}
          analyticsSource="related-projects"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          overrideGrid={true}
          animateIn={false}
        />
      </Section>
    </section>
  )
}
