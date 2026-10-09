import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import {
  SITE_APPLE_TOUCH_ICON_URL,
  SITE_DESCRIPTION,
  SITE_FAVICON_URL,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL
} from '../../lib/seo/seo-config'
import { DesignSystemProvider } from './design-system-provider'
import {
  AnalyticsTracker,
  BackToTop,
  FavoritesProvider,
  GoogleTagManagerNoScript,
  GoogleTagManagerScript
} from './root-shell-client'

export const rootLayoutMetadata: Metadata = {
  title: {
    default: `${SITE_NAME} - ${SITE_TAGLINE}`,
    template: `%s | ${SITE_NAME}`
  },
  description: SITE_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  icons: {
    icon: SITE_FAVICON_URL,
    apple: SITE_APPLE_TOUCH_ICON_URL
  }
}

/**
 * The Cloudflare Web Analytics beacon (#170), at the end of `<body>` where Cloudflare's own
 * injection puts it. The layout passes a token only on the public production site.
 */
function CloudflareWebAnalyticsBeacon({ token }: { token?: string }) {
  if (!token) return null
  return (
    <script
      data-cf-beacon={JSON.stringify({ token })}
      defer
      src="https://static.cloudflareinsights.com/beacon.min.js"
    />
  )
}

interface RootAppShellProps {
  /** The font variables and base classes, on `<html>` as on the other SERP sites. */
  htmlClassName?: string
  children: ReactNode
  /** The Cloudflare Web Analytics site token; no beacon without it. */
  cloudflareWebAnalyticsToken?: string
  feedTitle: string
  gtmId?: string
}

export function RootAppShell({
  children,
  cloudflareWebAnalyticsToken,
  feedTitle,
  gtmId,
  htmlClassName
}: RootAppShellProps) {
  return (
    <html lang="en" className={htmlClassName} suppressHydrationWarning>
      {/* biome-ignore lint/style/noHeadElement: the App Router root layout owns <head>; next/head is the Pages Router's. */}
      <head>
        <GoogleTagManagerScript gtmId={gtmId} />
        <link rel="alternate" type="application/feed+json" title={feedTitle} href="/rss.xml" />
      </head>
      <body>
        <GoogleTagManagerNoScript gtmId={gtmId} />
        <DesignSystemProvider>
          <FavoritesProvider>
            <AnalyticsTracker />
            {children}
            <BackToTop />
          </FavoritesProvider>
        </DesignSystemProvider>
        <CloudflareWebAnalyticsBeacon token={cloudflareWebAnalyticsToken} />
      </body>
    </html>
  )
}
