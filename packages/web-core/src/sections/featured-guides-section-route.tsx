import type { GuideMetadata } from '../content-query'
import { Section } from '../layout/section'
import { FeaturedGuidesSection as SharedFeaturedGuidesSection } from './featured-guides-section'
import { GuideCardRoute } from './guide-card-route'

interface FeaturedGuidesSectionRouteProps {
  guides: GuideMetadata[]
}

export function FeaturedGuidesSectionRoute({
  guides,
}: FeaturedGuidesSectionRouteProps) {
  return (
    <SharedFeaturedGuidesSection
      guides={guides}
      slots={{ GuideCard: GuideCardRoute, Section }}
    />
  )
}
