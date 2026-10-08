import { notFound } from 'next/navigation'
import {
  generateDisabledRouteMetadata,
  isRouteFeatureEnabled,
  type RoutableSiteFeature
} from '@/lib/site/route-feature-gates'

export function requireRouteFeature(feature: RoutableSiteFeature): void {
  if (!isRouteFeatureEnabled(feature)) {
    notFound()
  }
}

export { generateDisabledRouteMetadata, isRouteFeatureEnabled }
