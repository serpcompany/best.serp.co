import { HomePageRoute, homePageMetadata } from '@serpdirectory/web-core/home-page'
import { JsonLd } from '@serpdirectory/web-core/json-ld'
import { CreatorProjectsSectionRoute as CreatorProjectsSection } from '@serpdirectory/web-core/sections/creator-projects-section-route'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@serpdirectory/web-core/sections/external-resources-section-route'
import { FeaturedGuidesSectionRoute as FeaturedGuidesSection } from '@serpdirectory/web-core/sections/featured-guides-section-route'
import { FeaturedProjectsSectionRoute as FeaturedProjectsSection } from '@serpdirectory/web-core/sections/featured-projects-section-route'
import { RecentlyAddedSectionRoute as RecentlyAddedSection } from '@serpdirectory/web-core/sections/recently-added-section-route'
import { StaticWebsitesListRoute as StaticWebsitesList } from '@serpdirectory/web-core/sections/static-websites-list-route'
import type { Metadata } from 'next'
import { getHomePageData } from '@/actions/get-home-page-data'

export const metadata: Metadata = homePageMetadata

export default async function Home() {
  return (
    <HomePageRoute
      data={await getHomePageData()}
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
  )
}
