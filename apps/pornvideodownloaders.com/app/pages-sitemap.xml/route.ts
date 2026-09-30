import { createPagesSitemapResponse } from '@serpdirectory/web-core/sitemaps'

export const dynamic = 'force-static'

export async function GET(): Promise<Response> {
  return createPagesSitemapResponse()
}
