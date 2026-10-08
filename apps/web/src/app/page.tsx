import {
  HomePageCanonicalTags,
  HomePageRoute,
  homePageMetadata
} from '@/components/home/home-page'
import { JsonLd } from '@/components/seo/json-ld'
import { CreatorProjectsSectionRoute as CreatorProjectsSection } from '@/components/sections/creator-projects-section-route'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@/components/sections/external-resources-section-route'
import { FeaturedGuidesSectionRoute as FeaturedGuidesSection } from '@/components/sections/featured-guides-section-route'
import { FeaturedProjectsSectionRoute as FeaturedProjectsSection } from '@/components/sections/featured-projects-section-route'
import { RecentlyAddedSectionRoute as RecentlyAddedSection } from '@/components/sections/recently-added-section-route'
import { StaticWebsitesListRoute as StaticWebsitesList } from '@/components/sections/static-websites-list-route'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getHomePageData } from '@/actions/get-home-page-data'

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
