import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, permanentRedirect } from 'next/navigation'
import { ClaimListing } from '@/components/claims/claim-listing'
import { GoneListing } from '@/components/listing/gone-listing'
import {
  generateWebsiteDetailRouteMetadata,
  WebsiteDetailRoutePage
} from '@/components/website-routes/detail-page'
import {
  getActiveCategories,
  getBestPages,
  getCategoryBySlug,
  getUnpublishedListing
} from '@/lib/catalog/repository'
import { currentClaimCopy, currentClaimFlags } from '@/lib/claims/current'
import { getWebsiteBySlug, getWebsiteCanonicalRedirect } from '@/lib/content-loader'
import { featuredInBestPages } from '@/lib/directory/featured-in'
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
 * The 410 page links the listing's hub while the hub's page renders (it has a public listing,
 * #347), else the directory.
 */
async function withRenderingHub(
  gone: NonNullable<Awaited<ReturnType<typeof getUnpublishedListing>>>
) {
  const hub = gone.category ? await getCategoryBySlug(gone.category) : null
  return hub && hub.count > 0 ? gone : { ...gone, category: null, categoryName: null }
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
    if (gone) return <GoneListing listing={await withRenderingHub(gone)} />
    notFound()
  }

  // The claim link (#67, #70 screen 9a) on a listing without an owner, while claims are on.
  const claim =
    !project.verifiedOwner && (await currentClaimFlags()).enabled
      ? claimLink(project.name, project.slug, await currentClaimCopy())
      : undefined
  // Category names and "Featured in" come from the cached shell stats and best index (#347).
  const [categories, bestPages] = await Promise.all([getActiveCategories(), getBestPages()])
  return (
    <WebsiteDetailRoutePage
      categoryNames={new Map(categories.map(category => [category.slug, category.name]))}
      claim={claim}
      featuredIn={featuredInBestPages(project, bestPages)}
      project={project}
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
