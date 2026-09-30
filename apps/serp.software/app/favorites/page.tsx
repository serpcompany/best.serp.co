import {
  FavoritesIndexPage,
  favoritesPageMetadata
} from '@serpdirectory/web-core/favorites/index-page'
import { JsonLd } from '@serpdirectory/web-core/json-ld'
import { FeaturedGuidesSectionRoute as FeaturedGuidesSection } from '@serpdirectory/web-core/sections/featured-guides-section-route'
import { WebsitesListWithSearchRoute as WebsitesListWithSearch } from '@serpdirectory/web-core/websites-list-with-search-route'
import type { Metadata } from 'next'
import { getHomePageData } from '@/actions/get-home-page-data'
import { getGuides } from '@/lib/content-loader'
import { requireRouteFeature } from '@/lib/route-feature-gates'

export const metadata: Metadata = favoritesPageMetadata

export default async function FavoritesPage() {
  requireRouteFeature('showFavorites')

  const { allProjects, featuredProjects, totalCount } = await getHomePageData()
  const featuredGuides = await getGuides()

  return (
    <FavoritesIndexPage
      allProjects={allProjects}
      featuredGuides={featuredGuides}
      featuredProjects={featuredProjects}
      totalCount={totalCount}
      slots={{
        FeaturedGuidesSection,
        JsonLd,
        WebsitesListWithSearch
      }}
    />
  )
}
