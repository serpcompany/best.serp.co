import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { HtmlSitemapListings, htmlSitemapListingsMetadata } from '@/components/sitemap/html-sitemap'
import { getSitemapListingPage } from '@/lib/catalog/repository'
import { parseHtmlSitemapPageSegment } from '@/lib/seo/html-sitemap'

interface HtmlSitemapListingsPageProps {
  params: Promise<{ page: string }>
}

/** The page number, or a 404 for a segment that names no page (`1` redirects in `next.config`). */
async function pageNumber(params: HtmlSitemapListingsPageProps['params']): Promise<number> {
  const page = parseHtmlSitemapPageSegment((await params).page)
  if (page === null) notFound()
  return page
}

export async function generateMetadata({
  params
}: HtmlSitemapListingsPageProps): Promise<Metadata> {
  return htmlSitemapListingsMetadata(await pageNumber(params))
}

/** The HTML sitemap's listings page 2 onward (#53); a page past the last answers 404. */
export default async function HtmlSitemapListingsNumberedPage({
  params
}: HtmlSitemapListingsPageProps) {
  const result = await getSitemapListingPage(await pageNumber(params))
  if (!result) notFound()
  return <HtmlSitemapListings result={result} />
}
