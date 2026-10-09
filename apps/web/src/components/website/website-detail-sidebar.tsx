import { Download, ExternalLink, Hash } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePreviewPathFromKey,
  getFeaturedOnBadgePublicUrlFromKey
} from '@/lib/directory/featured-on-badge-url'
import { cn } from '@/lib/utils'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import type { WebsiteLinkRel } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { siteContent } from '../../lib/site/site-content'
import { FeaturedOnBadgeEmbedPanel } from './featured-on-badge-embed-panel'

type WebsiteSidebarMetadata = {
  category?: string
  /** A listing with a current owner shows no claim link (#70 screen 9). */
  verifiedOwner?: true
  categories?: string[]
  linkRel: WebsiteLinkRel
  name: string
  publishedAt?: string
  slug: string
  website: string
}

export type WebsiteDetailSidebarProps = {
  /**
   * The claim link (#67, #70 screen 9a: "Work at …? Claim this listing"), shown under the
   * categories of a listing that has no owner. The app passes it while claims are on.
   */
  claim?: ReactNode
  website: WebsiteSidebarMetadata
}

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

export function WebsiteDetailSidebar({ claim, website }: WebsiteDetailSidebarProps) {
  const outboundWebsiteUrl = withDubVia(website.website)
  const listingUrl = getFeaturedOnBadgeListingUrl({
    listingBasePath: siteConfig.listingRouteBasePath,
    listingDetailSuffix: siteConfig.sitemap.listingDetailSuffix,
    publicUrl: siteConfig.publicUrl,
    slug: website.slug
  })
  const badgeKeys = siteConfig.badges.featuredOn
  const badgeUrls = {
    dark: getFeaturedOnBadgePublicUrlFromKey(badgeKeys.dark, siteConfig.publicUrl),
    light: getFeaturedOnBadgePublicUrlFromKey(badgeKeys.light, siteConfig.publicUrl)
  }
  const badgePreviewUrls = {
    dark: getFeaturedOnBadgePreviewPathFromKey(badgeKeys.dark),
    light: getFeaturedOnBadgePreviewPathFromKey(badgeKeys.light)
  }
  const cliSlug = siteContent.listingCliInstall?.installTargetByListingSlug?.[website.slug]
  const categorySlugs = [
    ...(website.category ? [website.category] : []),
    ...(website.categories || [])
  ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)

  return (
    <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
      <Link
        href={outboundWebsiteUrl}
        target="_blank"
        rel={outboundWebsiteRel(website.linkRel)}
        className={cn(buttonVariants({ size: 'lg' }), 'sticky top-20 z-20 w-full')}
      >
        Visit Site
        <ExternalLink data-icon="inline-end" aria-hidden />
      </Link>

      <div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6 space-y-6">
        {cliSlug && (
          <div>
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Download className="size-3" aria-hidden />
              CLI Slug
            </span>
            <p className="mt-1 text-sm font-mono text-foreground">{cliSlug}</p>
          </div>
        )}

        {categorySlugs.length > 0 && (
          <div>
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Hash className="size-3" aria-hidden />
              {categorySlugs.length > 1 ? 'Categories' : 'Category'}
            </span>
            <div className="mt-1 flex flex-wrap gap-2">
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
          </div>
        )}
        {claim && !website.verifiedOwner ? claim : null}
      </div>

      <FeaturedOnBadgeEmbedPanel
        badgePreviewUrls={badgePreviewUrls}
        badgeUrls={badgeUrls}
        listingUrl={listingUrl}
        siteId={siteConfig.id}
        siteName={siteConfig.badges.featuredOn.displayName}
      />
    </aside>
  )
}
