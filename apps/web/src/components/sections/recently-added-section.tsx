import type { ComponentType, ReactNode } from 'react'
import type {
  WebsiteBrowseCardMetadata,
  WebsiteRelatedCardMetadata
} from '../../lib/directory/content-query'
import { siteConfig } from '../../lib/site/site-config'

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
  className?: string
  maxItems?: number
  analyticsSource?: string
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
      <LLMGrid items={recentWebsites} analyticsSource="recently-added" />
    </Section>
  )
}
