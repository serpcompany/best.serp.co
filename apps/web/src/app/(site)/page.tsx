import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getHomePageData } from '@/actions/get-home-page-data'
import { HomePageCanonicalTags, HomePageRoute, homePageMetadata } from '@/components/home/home-page'
import { FeaturedProjectsSectionRoute as FeaturedProjectsSection } from '@/components/sections/featured-projects-section-route'
import { RecentlyAddedSectionRoute as RecentlyAddedSection } from '@/components/sections/recently-added-section-route'
import { StaticWebsitesListRoute as StaticWebsitesList } from '@/components/sections/static-websites-list-route'
import { JsonLd } from '@/components/seo/json-ld'

export const metadata: Metadata = homePageMetadata

/** The homepage shows page 1 of the directory; later pages live at `/products/?page=N`. */
export default async function Home() {
  const data = await getHomePageData()
  if (!data) notFound()

  return (
    <>
      <HomePageCanonicalTags />
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
