import { DirectoryFeatureGrid } from '@serpdirectory/design-system/shadcnblocks/directory-home-section'
import type { ComponentType, ReactNode } from 'react'
import type { GuideMetadata } from '../content-query'
import { getRoute } from '../routes'

type SectionProps = {
  children: ReactNode
  description?: string
  title: string
  viewAllHref?: string
  viewAllText?: string
}

type GuideCardProps = {
  guide: GuideMetadata
}

interface FeaturedGuidesSectionProps {
  guides: GuideMetadata[]
  slots: {
    GuideCard: ComponentType<GuideCardProps>
    Section: ComponentType<SectionProps>
  }
}

export function FeaturedGuidesSection({ guides, slots }: FeaturedGuidesSectionProps) {
  if (guides.length === 0) {
    return null
  }

  const { GuideCard, Section } = slots

  return (
    <Section
      title="Featured Posts"
      description="Explore posts, walkthroughs, and reference notes for this directory."
      viewAllHref={getRoute('guides.list')}
      viewAllText="All posts"
    >
      <DirectoryFeatureGrid className="sm:grid-cols-2 sm:gap-6 lg:grid-cols-4 3xl:grid-cols-5 4xl:grid-cols-6">
        {guides.map(guide => (
          <GuideCard key={guide.slug} guide={guide} />
        ))}
      </DirectoryFeatureGrid>
    </Section>
  )
}
