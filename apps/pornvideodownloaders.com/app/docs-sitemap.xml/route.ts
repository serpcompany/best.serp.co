import { createDocsSitemapResponse } from '@serpdirectory/web-core/sitemaps'
import { getDocs } from '@/lib/content-loader'

export const dynamic = 'force-static'

export async function GET(): Promise<Response> {
  return createDocsSitemapResponse({ getWebsites: () => [], getDocs })
}
