import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePublicUrlFromKey
} from '@/lib/directory/featured-on-badge-url'
import { siteConfig } from '@/lib/site/site-config'

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

/**
 * The Tags field's choices (#341): each active tag with its hub's name, in the hubs' display
 * order, then the tags' own. A tag whose hub isn't among `categories` is left out.
 */
export function tagChoices(
  categories: ReadonlyArray<{ name: string; slug: string }>,
  tags: ReadonlyArray<{ category: string; name: string; slug: string }>
): Array<{ category: string; categoryName: string; label: string; slug: string }> {
  return categories.flatMap(category =>
    tags
      .filter(tag => tag.category === category.slug)
      .map(tag => ({
        category: category.slug,
        categoryName: category.name,
        label: tag.name,
        slug: tag.slug
      }))
  )
}
