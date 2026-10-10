import { getWebsites, type WebsiteMetadata } from '@/lib/content-loader'
import { getRoute } from '@/lib/routing/routes'
import { SITE_NAME, siteAppleTouchIconUrl, siteFaviconUrl, siteOrigin } from '@/lib/seo/seo-config'
import { siteCopy } from '@/lib/site/site-copy'

export const dynamic = 'force-dynamic'

/**
 * Handles GET requests to generate the RSS feed as JSON
 */
export async function GET() {
  const websitesData = await getWebsites()
  // This environment's origin: best.serp.co, or staging.best.serp.co on staging (#359).
  const baseUrl = siteOrigin()

  const feed = {
    version: 'https://jsonfeed.org/version/1',
    title: SITE_NAME,
    home_page_url: baseUrl,
    feed_url: `${baseUrl}/rss.xml`,
    description: `Latest updates from ${SITE_NAME}`,
    icon: siteAppleTouchIconUrl(),
    favicon: siteFaviconUrl(),
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
