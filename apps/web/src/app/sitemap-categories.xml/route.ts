import { getWebsites } from '@/lib/content-loader'
import { createTaxonomiesSitemapResponse } from '@/lib/seo/sitemaps'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return createTaxonomiesSitemapResponse({ getWebsites })
}
