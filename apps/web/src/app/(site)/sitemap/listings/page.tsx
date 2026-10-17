import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { HtmlSitemapListings, htmlSitemapListingsMetadata } from '@/components/sitemap/html-sitemap'
import { getSitemapListingPage } from '@/lib/catalog/repository'

export function generateMetadata(): Metadata {
  return htmlSitemapListingsMetadata(1)
}

/** The HTML sitemap's first listings page (#53). */
export default async function HtmlSitemapListingsPage() {
  const result = await getSitemapListingPage(1)
  if (!result) notFound()
  return <HtmlSitemapListings result={result} />
}
