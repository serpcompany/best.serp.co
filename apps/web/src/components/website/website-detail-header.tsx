import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePreviewPathFromKey,
  getFeaturedOnBadgePublicUrlFromKey
} from '@/lib/directory/featured-on-badge-url'
import { cn } from '@/lib/utils'
import { withDubVia } from '../../lib/analytics/dub-via'
import type { TaxonomyName, WebsiteLinkRel } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { FeaturedOnBadgeEmbedPanel } from './featured-on-badge-embed-panel'

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

export type WebsiteVisitLinkProps = {
  className?: string
  website: { linkRel: WebsiteLinkRel; website: string }
}

/**
 * The listing page's "Visit Site" (#273): a button-styled outbound link in the theme's blue `cta`
 * colour (#535), first and sticky on every screen.
 */
export function WebsiteVisitLink({ className, website }: WebsiteVisitLinkProps) {
  return (
    <Link
      href={withDubVia(website.website)}
      target="_blank"
      rel={outboundWebsiteRel(website.linkRel)}
      className={cn(
        buttonVariants({ size: 'lg' }),
        'bg-cta text-cta-foreground hover:bg-cta/90',
        className
      )}
    >
      Visit Site
      <ExternalLink data-icon="inline-end" aria-hidden />
    </Link>
  )
}

export type WebsiteDetailMetaWebsite = {
  /** Its categories with their names from D1, its hub (the primary) first (#347). */
  categories?: readonly TaxonomyName[]
  isUnofficial?: boolean
  /** Its active tags with their names from D1, the most central first (#341, #347). */
  tags?: readonly TaxonomyName[]
}

/**
 * The product page header's chips (#273): the Unofficial badge, then its hub badge, its other
 * categories and its tag chips as links (#347), named from D1. Nothing when the listing has none
 * of them. The Claimed badge sits by the name instead (#535).
 */
export function websiteDetailMeta(website: WebsiteDetailMetaWebsite): ReactNode {
  const [hub, ...otherCategories] = website.categories ?? []
  const tags = website.tags ?? []
  if (!website.isUnofficial && !hub && tags.length === 0) {
    return undefined
  }

  return (
    <>
      {website.isUnofficial ? (
        <Badge variant="outline" className="border-warning/30 text-warning">
          Unofficial
        </Badge>
      ) : null}
      {hub || tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {/* The hub as on a best page's entries (#346): secondary, its tags outline. */}
          {hub ? (
            <Badge
              variant="secondary"
              render={<Link href={getRoute('category.page', { category: hub.slug })} />}
            >
              {hub.name}
            </Badge>
          ) : null}
          {otherCategories.map(category => (
            <Badge
              key={category.slug}
              variant="outline"
              render={<Link href={getRoute('category.page', { category: category.slug })} />}
            >
              {category.name}
            </Badge>
          ))}
          {tags.map(tag => (
            <Badge
              key={tag.slug}
              variant="outline"
              render={<Link href={getRoute('tag.page', { tag: tag.slug })} />}
            >
              {tag.name}
            </Badge>
          ))}
        </div>
      ) : null}
    </>
  )
}

export type WebsiteDetailAsideProps = {
  /**
   * The claim link (#67, #70 screen 9a: "Claim this listing") of a listing that has no owner. The
   * app passes it while claims are on.
   */
  claim?: ReactNode
  website: { slug: string; verifiedOwner?: true }
}

const BADGE_EMBED_HEADING_ID = 'badge-embed-heading'

/**
 * The product page's maker block (#491, #535): a card of the "Featured on" badge for the page's
 * theme, then the claim in its footer, after Visit Site and Alternatives and never sticky, so it
 * doesn't compete with them. An `aside` named by its heading.
 */
export function WebsiteDetailAside({ claim, website }: WebsiteDetailAsideProps) {
  const listingUrl = getFeaturedOnBadgeListingUrl({
    listingBasePath: siteConfig.listingRouteBasePath,
    listingDetailSuffix: siteConfig.sitemap.listingDetailSuffix,
    publicUrl: siteConfig.publicUrl,
    slug: website.slug
  })
  const badgeKeys = siteConfig.badges.featuredOn
  const claimLink = claim && !website.verifiedOwner ? claim : null

  return (
    <aside aria-labelledby={BADGE_EMBED_HEADING_ID}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={BADGE_EMBED_HEADING_ID}>Click a badge to copy its code.</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
        {claimLink ? <CardFooter>{claimLink}</CardFooter> : null}
      </Card>
    </aside>
  )
}
