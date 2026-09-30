import { createPostsSitemapResponse } from '@serpdirectory/web-core/sitemaps'
import { getGuides } from '@/lib/content-loader'

export const dynamic = 'force-static'

export async function GET(): Promise<Response> {
  return createPostsSitemapResponse({ getWebsites: () => [], getGuides })
}
