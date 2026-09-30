import { createListingsSitemapResponse } from '@serpdirectory/web-core/sitemaps'
import { getWebsites } from '@/lib/content-loader'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return createListingsSitemapResponse({ getWebsites })
}
