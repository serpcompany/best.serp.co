import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getCanonicalListingListRoute } from '../../lib/routing/routes'
import { Section } from '../layout/section'
import { LLMGrid } from '../llm/llm-grid'

export type WebsiteRelatedProps = {
  websites: WebsiteRelatedCardMetadata[]
}

/**
 * A listing page's Related section (#535), under its article in the look the Alternatives
 * section had (#519): up to six more listings in its hub, none of them in its Alternatives.
 * Nothing when its hub has none left to show.
 */
export function WebsiteRelated({ websites }: WebsiteRelatedProps) {
  if (websites.length === 0) {
    return null
  }

  return (
    <Section
      title="Related"
      viewAllHref={getCanonicalListingListRoute()}
      viewAllText="Browse the directory"
      titleId="related"
    >
      <LLMGrid items={websites} analyticsSource="related-projects" />
    </Section>
  )
}
