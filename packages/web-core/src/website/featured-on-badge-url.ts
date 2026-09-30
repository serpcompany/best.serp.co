export type FeaturedOnBadgeTheme = 'light' | 'dark'

type FeaturedOnBadgeListingUrlInput = {
  listingBasePath: string
  listingDetailSuffix?: string
  publicUrl: string
  slug: string
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePathSegment(value: string | undefined): string {
  return (value ?? '').replace(/^\/+|\/+$/g, '')
}

function normalizeBadgeKey(value: string): string {
  return value.replace(/^\/+/, '')
}

function getDefaultFeaturedOnBadgeKey(siteId: string, theme: FeaturedOnBadgeTheme): string {
  return `badge/featured-on-${siteId}-${theme}.svg`
}

export function getFeaturedOnBadgePreviewPathFromKey(badgeKey: string): string {
  return `/${normalizeBadgeKey(badgeKey)}`
}

export function getFeaturedOnBadgePreviewPath(siteId: string, theme: FeaturedOnBadgeTheme): string {
  return getFeaturedOnBadgePreviewPathFromKey(getDefaultFeaturedOnBadgeKey(siteId, theme))
}

export function getFeaturedOnBadgePublicUrlFromKey(badgeKey: string, publicBaseUrl = ''): string {
  const normalizedBadgeKey = normalizeBadgeKey(badgeKey)
  const normalizedPublicBaseUrl = trimTrailingSlash(publicBaseUrl)

  return normalizedPublicBaseUrl
    ? `${normalizedPublicBaseUrl}/${normalizedBadgeKey}`
    : `/${normalizedBadgeKey}`
}

export function getFeaturedOnBadgePublicUrl(
  siteId: string,
  theme: FeaturedOnBadgeTheme,
  publicBaseUrl = ''
): string {
  return getFeaturedOnBadgePublicUrlFromKey(
    getDefaultFeaturedOnBadgeKey(siteId, theme),
    publicBaseUrl
  )
}

export function getFeaturedOnBadgeListingUrl({
  listingBasePath,
  listingDetailSuffix,
  publicUrl,
  slug
}: FeaturedOnBadgeListingUrlInput): string {
  const normalizedPublicUrl = trimTrailingSlash(publicUrl)
  const pathSegments = [
    normalizePathSegment(listingBasePath),
    normalizePathSegment(slug),
    normalizePathSegment(listingDetailSuffix)
  ].filter(Boolean)

  return `${normalizedPublicUrl}/${pathSegments.join('/')}/`
}
