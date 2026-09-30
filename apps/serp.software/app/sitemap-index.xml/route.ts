import { createSitemapIndexResponse } from '@serpdirectory/web-core/sitemaps'
import { getDocs, getGuides, getWebsites } from '@/lib/content-loader'

export const dynamic = 'force-static'

export async function GET(): Promise<Response> {
  return createSitemapIndexResponse({
    getDocs,
    getGuides,
    getWebsites
  })
}
