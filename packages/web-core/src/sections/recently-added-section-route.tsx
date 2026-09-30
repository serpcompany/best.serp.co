import type { WebsiteBrowseCardMetadata } from '../content-query'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'
import { RecentlyAddedSection as SharedRecentlyAddedSection } from './recently-added-section'

interface RecentlyAddedSectionRouteProps {
  websites: WebsiteBrowseCardMetadata[]
  maxItems?: number
}

export function RecentlyAddedSectionRoute({
  websites,
  maxItems = 8
}: RecentlyAddedSectionRouteProps) {
  return (
    <SharedRecentlyAddedSection
      websites={websites}
      maxItems={maxItems}
      slots={{ LLMGrid, Section }}
    />
  )
}
