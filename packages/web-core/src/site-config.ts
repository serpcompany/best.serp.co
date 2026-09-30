import { resolveCheckedInSiteConfig, resolveRuntimeSiteId } from '@serpdirectory/site-contract'
import type {
  AssetSource,
  SiteBadgesConfig,
  SiteCopyConfig,
  SiteFeatureFlags,
  SiteSitemapConfig
} from '@serpdirectory/site-contract/types'

type SiteBrandingConfig = {
  appleTouchIconUrl?: string
  faviconUrl?: string
  logoUrl?: string
  opengraphImageUrl?: string
}

type ResolvedSiteBadgesConfig = {
  featuredOn: {
    dark: string
    displayName: string
    light: string
  }
}

export type SiteConfig = {
  badges: ResolvedSiteBadgesConfig
  brandsRouteBasePath: string
  branding: SiteBrandingConfig
  copy: SiteCopyConfig
  description: string
  docsRouteBasePath: string
  domain: string
  features: SiteFeatureFlags
  gtmId?: string
  githubIssueOwner: string | null
  githubIssueRepo: string | null
  githubIssuesUrl: string | null
  githubRepoUrl: string
  githubUrl: string
  id: string
  listingRouteBasePath: string
  name: string
  networkBrandGroup: string | null
  networkRouteBasePath: string
  publicUrl: string
  redditUrl: string
  sitemap: SiteSitemapConfig
  tagline: string
  twitterUrl: string
}

const runtimeBrandAssetPaths = {
  favicon: '/favicon.ico',
  logo: '/logo.png',
  opengraphImage: '/opengraph-image.png'
} as const

function getDefaultFeaturedOnBadgeKey(siteId: string, theme: 'light' | 'dark'): string {
  return `badge/featured-on-${siteId}-${theme}.svg`
}

function resolveFeaturedOnBadges(
  siteId: string,
  siteName: string,
  badges: SiteBadgesConfig | undefined
) {
  return {
    dark: badges?.featuredOn?.dark ?? getDefaultFeaturedOnBadgeKey(siteId, 'dark'),
    displayName: badges?.featuredOn?.displayName ?? siteName,
    light: badges?.featuredOn?.light ?? getDefaultFeaturedOnBadgeKey(siteId, 'light')
  }
}

export function getTwitterHandleFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url)
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean)
    const handle = pathSegments.at(-1)

    if (!handle) {
      return null
    }

    return `@${handle}`
  } catch {
    return null
  }
}

export function hasConfiguredGitHubIssueTarget(config: SiteConfig): boolean {
  return Boolean(config.githubIssueOwner && config.githubIssueRepo && config.githubIssuesUrl)
}

export function hasConfiguredPublicSocialLinks(config: SiteConfig): boolean {
  return Boolean(config.githubRepoUrl && config.githubUrl && config.redditUrl && config.twitterUrl)
}

export function getConfiguredSocialLinks(config: SiteConfig): string[] {
  if (!hasConfiguredPublicSocialLinks(config)) {
    return []
  }

  return [config.githubUrl, config.redditUrl, config.twitterUrl]
}

function resolveRuntimeBrandAssetUrl(
  asset: AssetSource | undefined,
  kind: keyof typeof runtimeBrandAssetPaths
): string | undefined {
  if (!asset) {
    return undefined
  }

  if (asset.source === 'url') {
    return asset.url
  }

  return runtimeBrandAssetPaths[kind]
}

export function resolveSiteConfig(siteId = resolveRuntimeSiteId()): SiteConfig {
  const configuredSite = resolveCheckedInSiteConfig(siteId)

  return {
    badges: {
      featuredOn: resolveFeaturedOnBadges(
        configuredSite.id,
        configuredSite.site.name,
        configuredSite.badges
      )
    },
    branding: {
      appleTouchIconUrl: resolveRuntimeBrandAssetUrl(configuredSite.branding.logo, 'logo')
        ? '/apple-touch-icon.png'
        : undefined,
      faviconUrl: resolveRuntimeBrandAssetUrl(configuredSite.branding.favicon, 'favicon'),
      logoUrl: resolveRuntimeBrandAssetUrl(configuredSite.branding.logo, 'logo'),
      opengraphImageUrl: resolveRuntimeBrandAssetUrl(
        configuredSite.branding.opengraphImage,
        'opengraphImage'
      )
    },
    brandsRouteBasePath: configuredSite.routes.brandsBasePath,
    copy: configuredSite.copy,
    description: configuredSite.site.description,
    docsRouteBasePath: configuredSite.routes.docsBasePath,
    domain: configuredSite.site.domain,
    features: configuredSite.features,
    gtmId: configuredSite.analytics?.gtmId,
    githubIssueOwner: configuredSite.social.githubIssueOwner,
    githubIssueRepo: configuredSite.social.githubIssueRepo,
    githubIssuesUrl: configuredSite.social.githubIssuesUrl,
    githubRepoUrl: configuredSite.social.githubRepoUrl,
    githubUrl: configuredSite.social.githubUrl,
    id: configuredSite.id,
    listingRouteBasePath: configuredSite.routes.listingBasePath,
    name: configuredSite.site.name,
    networkBrandGroup: configuredSite.networkBrandGroup,
    networkRouteBasePath: configuredSite.routes.networkBasePath,
    publicUrl: configuredSite.site.publicUrl,
    redditUrl: configuredSite.social.redditUrl,
    sitemap: configuredSite.sitemap,
    tagline: configuredSite.site.tagline,
    twitterUrl: configuredSite.social.twitterUrl
  }
}

export const siteConfig: SiteConfig = resolveSiteConfig()
