import { JsonLd } from '@serpdirectory/web-core/json-ld'
import { ProjectNavigation } from '@serpdirectory/web-core/project-navigation'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@serpdirectory/web-core/sections/external-resources-section-route'
import { WebsiteContentSectionRoute as WebsiteContentSection } from '@serpdirectory/web-core/website/website-content-section-route'
import { WebsiteDetailSidebar } from '@serpdirectory/web-core/website/website-detail-sidebar'
import { WebsiteHeroRoute as WebsiteHero } from '@serpdirectory/web-core/website/website-hero-route'
import { WebsiteRelatedProjectsRoute as WebsiteRelatedProjects } from '@serpdirectory/web-core/website/website-related-projects-route'
import { WebsiteResourcesSectionRoute as WebsiteResourcesSection } from '@serpdirectory/web-core/website/website-resources-section-route'
import {
  generateWebsiteDetailRouteMetadata,
  WebsiteDetailRoutePage
} from '@serpdirectory/web-core/website-routes/detail-page'
import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { getWebsiteBySlug, getWebsiteCanonicalRedirect } from '@/lib/content-loader'

interface ProjectPageProps {
  params: Promise<{ slug: string }>
}

/**
 * Generates metadata for the website page
 *
 * @param params - Page parameters containing the website slug
 * @returns Promise<Metadata> - Generated metadata for the page
 */
export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const { slug } = await params

  const project = await getWebsiteBySlug(slug)

  if (!project) return {}

  return generateWebsiteDetailRouteMetadata(project)
}

/**
 * Website detail page component
 *
 * @param params - Page parameters containing the website slug
 * @returns Promise<JSX.Element> - Rendered website page
 */
export default async function ProjectPage({ params }: ProjectPageProps) {
  const { slug } = await params

  const project = await getWebsiteBySlug(slug)

  if (!project) {
    const canonicalSlug = await getWebsiteCanonicalRedirect(slug)
    if (canonicalSlug) permanentRedirect(`/products/${canonicalSlug}/`)
    notFound()
  }

  return (
    <WebsiteDetailRoutePage
      project={project}
      slots={{
        ExternalResourcesSection,
        JsonLd,
        ProjectNavigation,
        WebsiteContentSection,
        WebsiteDetailSidebar,
        WebsiteHero,
        WebsiteRelatedProjects,
        WebsiteResourcesSection
      }}
    />
  )
}
