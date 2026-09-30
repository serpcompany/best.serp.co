import {
  generateProjectsPageMetadata,
  ProjectsPageRoute
} from '@serpdirectory/web-core/projects-page'
import type { Metadata } from 'next'
import {
  generateDisabledRouteMetadata,
  isRouteFeatureEnabled,
  requireRouteFeature
} from '@/lib/route-feature-gates'

export function generateMetadata(): Metadata {
  if (!isRouteFeatureEnabled('showProjects')) {
    return generateDisabledRouteMetadata()
  }

  return generateProjectsPageMetadata()
}

export default function ProjectsPage() {
  requireRouteFeature('showProjects')

  return <ProjectsPageRoute />
}
