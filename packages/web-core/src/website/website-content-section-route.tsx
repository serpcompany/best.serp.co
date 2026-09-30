import type { WebsiteMetadata } from '../content-query'
import { components } from '../mdx-components'
import { WebsiteContentSection as SharedWebsiteContentSection } from './website-content-section'

interface WebsiteContentSectionRouteProps {
  website: WebsiteMetadata
}

export function WebsiteContentSectionRoute({
  website,
}: WebsiteContentSectionRouteProps) {
  return (
    <SharedWebsiteContentSection
      website={website}
      mdxComponents={components}
    />
  )
}
