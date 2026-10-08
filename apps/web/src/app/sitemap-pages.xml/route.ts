import { getWebsites } from '@/lib/content-loader'
import { createPagesSitemapResponse } from '@/lib/seo/sitemaps'

// Reads D1 for `lastmod` (#218), so it renders per request (the edge cache keeps it per epoch).
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return createPagesSitemapResponse({ getWebsites })
}
