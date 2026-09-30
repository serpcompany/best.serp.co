export const DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH = '/listing-logos/favicon-fallback-512x512.png'
export const SITE_BRAND_LISTING_LOGO_FALLBACK_PATH = '/logo.png'
const supportedRelativeLogoExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg'] as const

function normalizeAssetReference(assetReference?: string): string {
  return assetReference?.split('#')[0].split('?')[0].trim().toLowerCase() ?? ''
}

export function shouldUseProvidedListingLogo(logoUrl?: string): boolean {
  const normalizedReference = normalizeAssetReference(logoUrl)

  if (!normalizedReference) {
    return false
  }

  if (normalizedReference.startsWith('https://') || normalizedReference.startsWith('http://')) {
    return true
  }

  return supportedRelativeLogoExtensions.some(extension => normalizedReference.endsWith(extension))
}

export function getListingLogoFallbackPath(): string {
  return DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH
}

export const LISTING_LOGO_FALLBACK_PATH = getListingLogoFallbackPath()
