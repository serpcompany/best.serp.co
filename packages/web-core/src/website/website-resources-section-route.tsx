import { Section } from '../layout/section'
import { WebsiteCliSectionRoute } from './website-cli-section-route'
import {
  WebsiteResourcesSection as SharedWebsiteResourcesSection,
  type WebsiteResourcesSectionProps as SharedWebsiteResourcesSectionProps
} from './website-resources-section'

interface WebsiteResourcesSectionRouteProps {
  website: SharedWebsiteResourcesSectionProps['website']
}

export function WebsiteResourcesSectionRoute({ website }: WebsiteResourcesSectionRouteProps) {
  return (
    <SharedWebsiteResourcesSection
      website={website}
      slots={{ Section, WebsiteCliSection: WebsiteCliSectionRoute }}
    />
  )
}
