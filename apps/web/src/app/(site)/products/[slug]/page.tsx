import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, permanentRedirect } from 'next/navigation'
import type { ComponentProps } from 'react'
import { ClaimListing } from '@/components/claims/claim-listing'
import { ProjectNavigation } from '@/components/directory/project-navigation'
import { GoneListing } from '@/components/listing/gone-listing'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@/components/sections/external-resources-section-route'
import { JsonLd } from '@/components/seo/json-ld'
import { WebsiteContentSectionRoute as WebsiteContentSection } from '@/components/website/website-content-section-route'
import { WebsiteDetailSidebar } from '@/components/website/website-detail-sidebar'
import { WebsiteFaqsSection } from '@/components/website/website-faqs-section'
import { WebsiteHeroRoute as WebsiteHero } from '@/components/website/website-hero-route'
import { WebsiteRelatedProjectsRoute as WebsiteRelatedProjects } from '@/components/website/website-related-projects-route'
import { WebsiteResourcesSectionRoute as WebsiteResourcesSection } from '@/components/website/website-resources-section-route'
import {
  generateWebsiteDetailRouteMetadata,
  WebsiteDetailRoutePage
} from '@/components/website-routes/detail-page'
import { getUnpublishedListing } from '@/lib/catalog/repository'
import { currentClaimCopy, currentClaimFlags } from '@/lib/claims/runtime'
import { getWebsiteBySlug, getWebsiteCanonicalRedirect } from '@/lib/content-loader'
import { getFeaturedOnBadgePreviewPathFromKey } from '@/lib/directory/featured-on-badge-url'
import { GONE_RENDER_HEADER } from '@/lib/routing/gone-listing'
import { getRoute } from '@/lib/routing/routes'
import { site } from '@/lib/site'
import { siteConfig } from '@/lib/site/site-config'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'

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

  if (!project) {
    const gone = await goneListing(slug)
    return gone
      ? { robots: { follow: true, index: false }, title: `${gone.name} is no longer listed` }
      : {}
  }

  return generateWebsiteDetailRouteMetadata(project)
}

/**
 * The unpublished listing to show on the 410 page, only when the Worker entry asks for that
 * render (`lib/routing/gone-listing.ts`); otherwise the page answers 404 as before.
 */
async function goneListing(slug: string) {
  if ((await headers()).get(GONE_RENDER_HEADER) !== '1') return null
  return getUnpublishedListing(slug)
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
    if (canonicalSlug) permanentRedirect(getRoute('listing.detail', { slug: canonicalSlug }))
    const gone = await goneListing(slug)
    if (gone) return <GoneListing listing={gone} />
    notFound()
  }

  // The claim link (#67, #70 screen 9a) on a listing without an owner, while claims are on.
  const claim =
    !project.verifiedOwner && (await currentClaimFlags()).enabled
      ? claimLink(project.name, project.slug, await currentClaimCopy())
      : undefined
  const Sidebar = (props: ComponentProps<typeof WebsiteDetailSidebar>) => (
    <WebsiteDetailSidebar {...props} claim={claim} />
  )

  return (
    <WebsiteDetailRoutePage
      project={project}
      slots={{
        ExternalResourcesSection,
        JsonLd,
        ProjectNavigation,
        WebsiteContentSection,
        WebsiteDetailSidebar: Sidebar,
        WebsiteFaqsSection,
        WebsiteHero,
        WebsiteRelatedProjects,
        WebsiteResourcesSection
      }}
    />
  )
}

function claimLink(name: string, slug: string, copy: Awaited<ReturnType<typeof currentClaimCopy>>) {
  const targets = submissionBadgeTargets(slug)
  const featuredOn = siteConfig.badges.featuredOn
  return (
    <ClaimListing
      badge={{
        badgeUrl: targets.badgeUrls[0] ?? '',
        siteName: featuredOn.displayName,
        listingUrl: targets.listingUrl,
        previewUrl: getFeaturedOnBadgePreviewPathFromKey(featuredOn.light)
      }}
      copy={copy}
      listing={{ name, slug }}
      priceCents={site.submissions.paidListingPriceCents}
    />
  )
}
