import { buildHomePageData, type HomePageData } from '@/components/home/home-page'
import {
  getFeaturedListings,
  getLatestListings,
  getListedCategorySlugs,
  getListingNamePage,
  getPublishedListingCount
} from '@/lib/catalog/repository'
import { getGuides } from '@/lib/content-loader'

const HOMEPAGE_CARD_SECTION_SIZE = 8

/**
 * Homepage and `/products/` data: the featured and recently added sections plus one page
 * of the directory. Every read is bounded (a page, eight cards, cached shell counts); the
 * full catalog is never loaded for display.
 *
 * @returns null when `page` is past the last directory page
 */
export async function getHomePageData(page = 1): Promise<HomePageData | null> {
  const [browse, featured, latest, activeCategorySlugs, totalCount] = await Promise.all([
    getListingNamePage({ page }),
    getFeaturedListings(HOMEPAGE_CARD_SECTION_SIZE),
    getLatestListings(HOMEPAGE_CARD_SECTION_SIZE),
    getListedCategorySlugs(),
    getPublishedListingCount()
  ])
  if (page > browse.pageCount) return null
  return buildHomePageData({
    activeCategorySlugs,
    browse,
    featured,
    guides: getGuides(),
    latest,
    totalCount
  })
}
