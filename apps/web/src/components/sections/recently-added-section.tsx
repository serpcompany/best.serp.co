import type { WebsiteBrowseCardMetadata } from '../../lib/directory/content-query'
import { siteConfig } from '../../lib/site/site-config'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'

interface RecentlyAddedSectionProps {
  websites: WebsiteBrowseCardMetadata[]
  maxItems?: number
}

export function RecentlyAddedSection({ websites, maxItems = 8 }: RecentlyAddedSectionProps) {
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
