import { getBestPages } from '@/lib/catalog/repository'
import { createBestPagesSitemapResponse } from '@/lib/seo/sitemaps'

// Reads D1 (#341), so it renders per request (the edge cache keeps it per epoch).
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return createBestPagesSitemapResponse({ getBestPages })
}
