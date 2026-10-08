import { siteConfig } from '@/lib/site/site-config'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePublicUrlFromKey
} from '@/components/website/featured-on-badge-url'

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

/**
 * Badges embedded before the route simplification link to /products/<slug>/reviews/.
 * That URL now redirects to the listing, so verification still accepts it.
 */
export function submissionBadgeVerificationTargets(slug: string) {
  const targets = submissionBadgeTargets(slug)
  return { ...targets, legacyListingUrls: [`${targets.listingUrl}reviews/`] }
}
