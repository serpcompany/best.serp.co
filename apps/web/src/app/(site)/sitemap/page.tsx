import type { Metadata } from 'next'
import { sitemapPageLinks } from '@/components/layout/site-links'
import {
  HtmlSitemapIndex,
  htmlSitemapMetadata,
  htmlSitemapSections
} from '@/components/sitemap/html-sitemap'
import { getActiveCategories, getBestPages, getSitemapListingTotal } from '@/lib/catalog/repository'
import { listedBestPages } from '@/lib/seo/taxonomy-indexing'

export function generateMetadata(): Metadata {
  return htmlSitemapMetadata()
}

/** The HTML sitemap (#53): every indexable hub page, then the numbered listing pages. */
export default async function HtmlSitemapPage() {
  const [categories, bestPages, listingTotal] = await Promise.all([
    getActiveCategories(),
    getBestPages(),
    getSitemapListingTotal()
  ])
  const pages = sitemapPageLinks({ bestIndexListed: listedBestPages(bestPages).length > 0 })
  return (
    <HtmlSitemapIndex
      sections={htmlSitemapSections({ bestPages, categories, listingTotal, pages })}
    />
  )
}
