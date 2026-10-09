import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getHomePageData } from '@/actions/get-home-page-data'
import { paginatedMetadata, parseListingPageParam } from '@/components/directory/listing-pagination'
import { HomePageCanonicalTags, HomePageRoute } from '@/components/home/home-page'
import { FeaturedProjectsSectionRoute as FeaturedProjectsSection } from '@/components/sections/featured-projects-section-route'
import { RecentlyAddedSectionRoute as RecentlyAddedSection } from '@/components/sections/recently-added-section-route'
import { StaticWebsitesListRoute as StaticWebsitesList } from '@/components/sections/static-websites-list-route'
import { JsonLd } from '@/components/seo/json-ld'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata, SITE_NAME } from '@/lib/seo/seo-config'
import { siteCopy } from '@/lib/site/site-copy'

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
          FeaturedProjectsSection,
          JsonLd,
          RecentlyAddedSection,
          StaticWebsitesList
        }}
      />
    </>
  )
}
