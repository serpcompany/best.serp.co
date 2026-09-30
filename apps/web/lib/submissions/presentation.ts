import { siteConfig } from '@serpdirectory/web-core/site-config'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePublicUrlFromKey
} from '@serpdirectory/web-core/website/featured-on-badge-url'

export function submissionBadgeTargets(slug: string) {
  const featuredOn = siteConfig.badges.featuredOn
  return {
    badgeUrls: [
      getFeaturedOnBadgePublicUrlFromKey(featuredOn.light, siteConfig.publicUrl),
      getFeaturedOnBadgePublicUrlFromKey(featuredOn.dark, siteConfig.publicUrl)
    ],
    listingUrl: getFeaturedOnBadgeListingUrl({
      listingBasePath: siteConfig.listingRouteBasePath,
      listingDetailSuffix: siteConfig.sitemap.listingDetailSuffix,
      publicUrl: siteConfig.publicUrl,
      slug
    })
  }
}
