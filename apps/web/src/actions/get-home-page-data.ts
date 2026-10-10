import { buildHomePageData, type HomePageData } from '@/components/home/home-page'
import {
  getActiveCategories,
  getActiveTags,
  getFeaturedListings,
  getLatestListings,
  getListingNamePage,
  getPublishedListingCount
} from '@/lib/catalog/repository'

const HOMEPAGE_CARD_SECTION_SIZE = 8

/**
 * Homepage and `/products/` data: the featured and recently added sections, the hub grid (#347),
 * plus one page of the directory. Every read is bounded (a page, eight cards, cached shell counts
 * and tag stats); the full catalog is never loaded for display.
 *
 * @returns null when `page` is past the last directory page
 */
export async function getHomePageData(page = 1): Promise<HomePageData | null> {
  const [browse, featured, latest, totalCount, categories, tags] = await Promise.all([
    getListingNamePage({ page }),
    getFeaturedListings(HOMEPAGE_CARD_SECTION_SIZE),
    getLatestListings(HOMEPAGE_CARD_SECTION_SIZE),
    getPublishedListingCount(),
    getActiveCategories(),
    getActiveTags()
  ])
  if (page > browse.pageCount) return null
  return buildHomePageData({ browse, categories, featured, latest, tags, totalCount })
}
