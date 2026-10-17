import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, permanentRedirect } from 'next/navigation'
import { ClaimListing } from '@/components/claims/claim-listing'
import { GONE_LISTING_ALTERNATIVES, GoneListing } from '@/components/listing/gone-listing'
import {
  generateWebsiteDetailRouteMetadata,
  WebsiteDetailRoutePage
} from '@/components/website-routes/detail-page'
import {
  getActiveCategories,
  getBestPages,
  getCategoryListings,
  getUnpublishedListing
} from '@/lib/catalog/repository'
import { notFoundLinkTargetsFrom } from '@/lib/catalog/site-nav'
import { currentClaimCopy, currentClaimFlags } from '@/lib/claims/current'
import { getWebsiteBySlug, getWebsiteCanonicalRedirect } from '@/lib/content-loader'
import { categoryNamesBySlug } from '@/lib/directory/categories'
import { toWebsiteBrowseCardMetadata } from '@/lib/directory/content-query'
import { featuredInBestPages } from '@/lib/directory/featured-in'
import { getFeaturedOnBadgePreviewPathFromKey } from '@/lib/directory/featured-on-badge-url'
import { GONE_RENDER_HEADER } from '@/lib/routing/gone-listing'
import { getRoute } from '@/lib/routing/routes'
import { categoryBestPages, renderingCategory } from '@/lib/seo/taxonomy-indexing'
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

  // The hub's name from the cached shell stats, as the page reads them (#416). Started with the
  // listing, as the page does, so a cold data cache waits on D1 once, not twice (#378).
  const categories = getActiveCategories()
  categories.catch(() => undefined)
  const project = await getWebsiteBySlug(slug)

  if (!project) {
    const gone = await goneListing(slug)
    return gone
      ? { robots: { follow: true, index: false }, title: `${gone.name} is no longer listed` }
      : {}
  }

  return generateWebsiteDetailRouteMetadata(project, categoryNamesBySlug(await categories))
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

  // Category names and "Featured in" come from the cached shell stats and best index (#347).
  // Started with the listing, so a cold data cache waits on D1 once, not twice (#378); awaited
  // only where they're used, so a failure surfaces there, as before.
  const shell = Promise.all([getActiveCategories(), getBestPages()])
  shell.catch(() => undefined)
  const project = await getWebsiteBySlug(slug)

  if (!project) {
    const canonicalSlug = await getWebsiteCanonicalRedirect(slug)
    if (canonicalSlug) permanentRedirect(getRoute('listing.detail', { slug: canonicalSlug }))
    const gone = await goneListing(slug)
    // Its hub only while the hub's page renders, else the directory (#347); the hub's first
    // listings as alternatives and its best pages (#53).
    if (gone) {
      const [categories, bestPages] = await shell
      const hub = renderingCategory(categories, gone.category)
      const alternatives = hub
        ? (await getCategoryListings(hub.slug, GONE_LISTING_ALTERNATIVES)).map(
            toWebsiteBrowseCardMetadata
          )
        : []
      return (
        <GoneListing
          alternatives={alternatives}
          bestPages={hub ? categoryBestPages(bestPages, hub.slug) : []}
          hub={hub}
          links={notFoundLinkTargetsFrom(categories, bestPages)}
          listing={gone}
        />
      )
    }
    notFound()
  }

  // The claim link (#67, #70 screen 9a) on a listing without an owner, while claims are on.
  const claim =
    !project.verifiedOwner && (await currentClaimFlags()).enabled
      ? claimLink(project.name, project.slug, await currentClaimCopy())
      : undefined
  const [categories, bestPages] = await shell
  return (
    <WebsiteDetailRoutePage
      categoryNames={categoryNamesBySlug(categories)}
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
