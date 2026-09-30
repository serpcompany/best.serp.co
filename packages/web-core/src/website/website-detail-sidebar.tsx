import { Download, ExternalLink, Hash } from 'lucide-react'
import Link from 'next/link'
import { getCategoryDisplayName } from '../category-display'
import { getRoute } from '../routes'
import { siteConfig } from '../site-config'
import { siteContent } from '../site-content'
import { FeaturedOnBadgeEmbedPanel } from './featured-on-badge-embed-panel'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePreviewPathFromKey,
  getFeaturedOnBadgePublicUrlFromKey
} from './featured-on-badge-url'

type WebsiteSidebarMetadata = {
  category?: string
  categories?: string[]
  name: string
  publishedAt?: string
  slug: string
  website: string
}

type OutboundViaConfig = {
  domain?: string | null
  publicUrl?: string | null
}

export type WebsiteDetailSidebarProps = {
  website: WebsiteSidebarMetadata
}

function resolveViaDomain(config: OutboundViaConfig): string | null {
  const configuredDomain = config.domain?.trim()

  if (configuredDomain) {
    return configuredDomain
  }

  const publicUrl = config.publicUrl?.trim()

  if (!publicUrl) {
    return null
  }

  try {
    return new URL(publicUrl).hostname || null
  } catch {
    return null
  }
}

function getOutboundUrlWithVia(url: string, config: OutboundViaConfig): string {
  const viaDomain = resolveViaDomain(config)

  if (!viaDomain) {
    return url
  }

  try {
    const parsedUrl = new URL(url)

    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.hostname !== 'serp.ly' ||
      parsedUrl.searchParams.has('via')
    ) {
      return url
    }

    parsedUrl.searchParams.set('via', viaDomain)

    return parsedUrl.toString()
  } catch {
    return url
  }
}

export function WebsiteDetailSidebar({ website }: WebsiteDetailSidebarProps) {
  const outboundWebsiteUrl = getOutboundUrlWithVia(website.website, siteConfig)
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
        rel="noopener noreferrer"
        className="sticky top-20 z-20 flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span>Visit Site</span>
        <ExternalLink className="size-4" aria-hidden />
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
                <Link
                  key={categorySlug}
                  href={getRoute('category.page', { category: categorySlug })}
                  className="inline-flex rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
                >
                  {getCategoryDisplayName(categorySlug)}
                </Link>
              ))}
            </div>
          </div>
        )}
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
