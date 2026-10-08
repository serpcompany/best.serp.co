import { createTaxonomiesSitemapResponse } from '@/lib/seo/sitemaps'
import { getWebsites } from '@/lib/content-loader'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return createTaxonomiesSitemapResponse({ getWebsites })
}
