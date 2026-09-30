import type { ComponentType, ReactNode } from 'react'
import type { WebsiteBrowseCardMetadata, WebsiteRelatedCardMetadata } from '../content-query'
import { siteConfig } from '../site-config'

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
  variant?: 'default' | 'compact'
  className?: string
  maxItems?: number
  animateIn?: boolean
  analyticsSource?: string
  overrideGrid?: boolean
}

interface RecentlyAddedSectionProps {
  websites: WebsiteBrowseCardMetadata[]
  maxItems?: number
  slots: {
    LLMGrid: ComponentType<LLMGridProps>
    Section: ComponentType<SectionProps>
  }
}

export function RecentlyAddedSection({
  websites,
  maxItems = 8,
  slots: { LLMGrid, Section }
}: RecentlyAddedSectionProps) {
  if (!websites || websites.length === 0) {
    return null
  }

  const recentWebsites = websites.slice(0, maxItems)

  return (
    <Section
      title="Recently Added"
      description={`See the newest entries added to ${siteConfig.name}`}
    >
      <LLMGrid
        items={recentWebsites}
        variant="default"
        animateIn={true}
        analyticsSource="recently-added"
      />
    </Section>
  )
}
