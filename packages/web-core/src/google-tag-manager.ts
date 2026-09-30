import type { SiteConfig } from './site-config'

export function resolveGoogleTagManagerId(
  siteConfig: Pick<SiteConfig, 'gtmId'>
): string | undefined {
  return siteConfig.gtmId
}
