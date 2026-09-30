import { getRoute } from '@serpdirectory/web-core/routes'
import {
  SITE_APPLE_TOUCH_ICON_URL,
  SITE_FAVICON_URL,
  SITE_NAME,
  SITE_PUBLIC_URL
} from '@serpdirectory/web-core/seo-config'
import { siteCopy } from '@serpdirectory/web-core/site-copy'
import { getWebsites, type WebsiteMetadata } from '@/lib/content-loader'

const baseUrl = SITE_PUBLIC_URL

export const dynamic = 'force-dynamic'

/**
 * Handles GET requests to generate the RSS feed as JSON
 */
export async function GET() {
  const websitesData = await getWebsites()

  const feed = {
    version: 'https://jsonfeed.org/version/1',
    title: SITE_NAME,
    home_page_url: baseUrl,
    feed_url: `${baseUrl}/rss.xml`,
    description: `Latest updates from ${SITE_NAME}`,
    icon: SITE_APPLE_TOUCH_ICON_URL,
    favicon: SITE_FAVICON_URL,
    authors: [
      {
        name: SITE_NAME,
        url: baseUrl
      }
    ],
    language: 'en',
    items: [
      ...websitesData.map((site: WebsiteMetadata) => ({
        id: site.slug,
        url: `${baseUrl}${getRoute('listing.detail', { slug: site.slug })}`,
        title: site.name,
        content_html: site.description,
        date_published: site.publishedAt,
        authors: [
          {
            name: SITE_NAME,
            url: baseUrl
          }
        ],
        categories: [siteCopy.listingName.singularTitle, site.category || 'Uncategorized']
      }))
    ]
  }

  return new Response(JSON.stringify(feed), {
    headers: {
      'content-type': 'application/json;charset=UTF-8'
    }
  })
}
