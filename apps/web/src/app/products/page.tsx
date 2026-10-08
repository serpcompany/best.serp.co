import { HomePageCanonicalTags, HomePageRoute } from '@serpdirectory/web-core/home-page'
import { JsonLd } from '@serpdirectory/web-core/json-ld'
import {
  paginatedMetadata,
  parseListingPageParam
} from '@serpdirectory/web-core/listing-pagination'
import { getRoute } from '@serpdirectory/web-core/routes'
import { CreatorProjectsSectionRoute as CreatorProjectsSection } from '@serpdirectory/web-core/sections/creator-projects-section-route'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@serpdirectory/web-core/sections/external-resources-section-route'
import { FeaturedGuidesSectionRoute as FeaturedGuidesSection } from '@serpdirectory/web-core/sections/featured-guides-section-route'
import { FeaturedProjectsSectionRoute as FeaturedProjectsSection } from '@serpdirectory/web-core/sections/featured-projects-section-route'
import { RecentlyAddedSectionRoute as RecentlyAddedSection } from '@serpdirectory/web-core/sections/recently-added-section-route'
import { StaticWebsitesListRoute as StaticWebsitesList } from '@serpdirectory/web-core/sections/static-websites-list-route'
import { generateBaseMetadata, SITE_NAME } from '@serpdirectory/web-core/seo-config'
import { siteCopy } from '@serpdirectory/web-core/site-copy'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getHomePageData } from '@/actions/get-home-page-data'

const productsPath = getRoute('listing.list')

// The root layout's title template adds ` | SERP`.
const productsMetadata: Metadata = generateBaseMetadata({
  title: `All ${siteCopy.listingName.pluralTitle} in the ${SITE_NAME} Directory`,
  description:
    'Discover a curated list of SERP products, software, AI tools, companies, and resources, and browse every listing in the directory page by page.',
  path: productsPath
})

interface ProductsPageProps {
  searchParams: Promise<{ page?: string | string[] }>
}

export async function generateMetadata({ searchParams }: ProductsPageProps): Promise<Metadata> {
  const page = parseListingPageParam((await searchParams).page)
  if (page > 1) return paginatedMetadata(productsMetadata, { basePath: productsPath, page })
  // The first page renders the homepage's content, so its canonical is `/` (the route registry,
  // #167). Next.js would write that as `https://best.serp.co/`, so the page renders
  // `HomePageCanonicalTags` instead, as the homepage does.
  const { alternates: _alternates, openGraph, ...metadata } = productsMetadata
  return { ...metadata, openGraph: openGraph ? { ...openGraph, url: undefined } : undefined }
}

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const page = parseListingPageParam((await searchParams).page)
  const data = await getHomePageData(page)
  if (!data) notFound()

  return (
    <>
      {page <= 1 ? <HomePageCanonicalTags /> : null}
      <HomePageRoute
        data={data}
        slots={{
          CreatorProjectsSection,
          ExternalResourcesSection,
          FeaturedGuidesSection,
          FeaturedProjectsSection,
          JsonLd,
          RecentlyAddedSection,
          StaticWebsitesList
        }}
      />
    </>
  )
}
