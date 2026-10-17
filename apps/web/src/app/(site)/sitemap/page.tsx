import type { Metadata } from 'next'
import { sitemapPageLinks } from '@/components/layout/site-links'
import {
  HtmlSitemapIndex,
  htmlSitemapGroups,
  htmlSitemapMetadata
} from '@/components/sitemap/html-sitemap'
import {
  getActiveCategories,
  getBestPages,
  getSitemapListingPageCount
} from '@/lib/catalog/repository'
import { listedBestPages } from '@/lib/seo/taxonomy-indexing'

export function generateMetadata(): Metadata {
  return htmlSitemapMetadata()
}

/** The HTML sitemap (#53): every indexable hub page, then the numbered listing pages. */
export default async function HtmlSitemapPage() {
  const [categories, bestPages, listingPageCount] = await Promise.all([
    getActiveCategories(),
    getBestPages(),
    getSitemapListingPageCount()
  ])
  const pages = sitemapPageLinks({ bestIndexListed: listedBestPages(bestPages).length > 0 })
  return (
    <HtmlSitemapIndex
      groups={htmlSitemapGroups({ bestPages, categories, listingPageCount, pages })}
    />
  )
}
