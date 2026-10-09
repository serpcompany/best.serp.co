import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePreviewPathFromKey,
  getFeaturedOnBadgePublicUrlFromKey
} from '@/lib/directory/featured-on-badge-url'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import type { WebsiteLinkRel } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { FavoriteButton } from '../favorites/favorite-button'
import { FeaturedOnBadgeEmbedPanel } from './featured-on-badge-embed-panel'
import { VerifiedOwnerBadge } from './verified-owner-badge'

const OUTBOUND_REL: Record<WebsiteLinkRel, string> = {
  follow: 'noopener noreferrer',
  nofollow: 'nofollow noopener noreferrer',
  sponsored: 'sponsored noopener noreferrer'
}

/**
 * The `rel` of the outbound "Visit Site" link, from the listing's admin setting (#62).
 * `follow` keeps the attribute every listing rendered before the setting existed.
 */
export function outboundWebsiteRel(linkRel: WebsiteLinkRel): string {
  return OUTBOUND_REL[linkRel] ?? OUTBOUND_REL.nofollow
}

export type WebsiteDetailActionsProps = {
  website: { linkRel: WebsiteLinkRel; slug: string; website: string }
}

/** The product page header's actions (#273): "Visit Site" and the favorite button. */
export function WebsiteDetailActions({ website }: WebsiteDetailActionsProps) {
  return (
    <>
      <Link
        href={withDubVia(website.website)}
        target="_blank"
        rel={outboundWebsiteRel(website.linkRel)}
        className={buttonVariants()}
      >
        Visit Site
        <ExternalLink data-icon="inline-end" aria-hidden />
      </Link>
      <FavoriteButton slug={website.slug} />
    </>
  )
}

export type WebsiteDetailMetaWebsite = {
  categories?: string[]
  category?: string
  isUnofficial?: boolean
  /** The public "Verified owner" badge (#70 screen 9b). */
  verifiedOwner?: true
}

/**
 * The product page header's meta row (#273): the Unofficial and Verified owner badges, then the
 * listing's categories as links. Nothing when the listing has none of them.
 */
export function websiteDetailMeta(website: WebsiteDetailMetaWebsite): ReactNode {
  const categorySlugs = [
    ...(website.category ? [website.category] : []),
    ...(website.categories || [])
  ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
  if (!website.isUnofficial && !website.verifiedOwner && categorySlugs.length === 0) {
    return undefined
  }

  return (
    <>
      {website.isUnofficial ? (
        <Badge variant="outline" className="border-warning/30 text-warning">
          Unofficial
        </Badge>
      ) : null}
      {website.verifiedOwner ? <VerifiedOwnerBadge /> : null}
      {categorySlugs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {categorySlugs.map(categorySlug => (
            <Badge
              key={categorySlug}
              variant="outline"
              render={<Link href={getRoute('category.page', { category: categorySlug })} />}
            >
              {getCategoryDisplayName(categorySlug)}
            </Badge>
          ))}
        </div>
      ) : null}
    </>
  )
}

export type WebsiteDetailAsideProps = {
  /**
   * The claim link (#67, #70 screen 9a: "Work at …? Claim this listing") of a listing that has
   * no owner. The app passes it while claims are on.
   */
  claim?: ReactNode
  website: { slug: string; verifiedOwner?: true }
}

/** The panel beside the product page header (#273): the "Featured on" badge, then the claim. */
export function WebsiteDetailAside({ claim, website }: WebsiteDetailAsideProps) {
  const listingUrl = getFeaturedOnBadgeListingUrl({
    listingBasePath: siteConfig.listingRouteBasePath,
    listingDetailSuffix: siteConfig.sitemap.listingDetailSuffix,
    publicUrl: siteConfig.publicUrl,
    slug: website.slug
  })
  const badgeKeys = siteConfig.badges.featuredOn

  return (
    <div className="flex flex-col gap-4">
      <FeaturedOnBadgeEmbedPanel
        badgePreviewUrls={{
          dark: getFeaturedOnBadgePreviewPathFromKey(badgeKeys.dark),
          light: getFeaturedOnBadgePreviewPathFromKey(badgeKeys.light)
        }}
        badgeUrls={{
          dark: getFeaturedOnBadgePublicUrlFromKey(badgeKeys.dark, siteConfig.publicUrl),
          light: getFeaturedOnBadgePublicUrlFromKey(badgeKeys.light, siteConfig.publicUrl)
        }}
        listingUrl={listingUrl}
        siteId={siteConfig.id}
        siteName={badgeKeys.displayName}
      />
      {claim && !website.verifiedOwner ? claim : null}
    </div>
  )
}
