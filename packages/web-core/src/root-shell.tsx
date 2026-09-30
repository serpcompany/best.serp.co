import { DesignSystemProvider } from '@serpdirectory/design-system/theme-provider'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import {
  AnalyticsTracker,
  BackToTop,
  FavoritesProvider,
  GoogleTagManagerNoScript,
  GoogleTagManagerScript
} from './root-shell-client'
import {
  SITE_APPLE_TOUCH_ICON_URL,
  SITE_DESCRIPTION,
  SITE_FAVICON_URL,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL
} from './seo-config'

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

interface RootAppShellProps {
  bodyClassName?: string
  children: ReactNode
  feedTitle: string
  footer: ReactNode
  gtmId?: string
  header: ReactNode
}

export function RootAppShell({
  bodyClassName,
  children,
  feedTitle,
  footer,
  gtmId,
  header
}: RootAppShellProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <GoogleTagManagerScript gtmId={gtmId} />
        <link rel="alternate" type="application/feed+json" title={feedTitle} href="/rss.xml" />
      </head>
      <body className={bodyClassName}>
        <GoogleTagManagerNoScript gtmId={gtmId} />
        <DesignSystemProvider>
          <FavoritesProvider>
            <AnalyticsTracker />
            <div className="flex min-h-screen flex-col">
              {header}
              <main className="flex flex-1 flex-col">{children}</main>
              {footer}
            </div>
            <BackToTop />
          </FavoritesProvider>
        </DesignSystemProvider>
      </body>
    </html>
  )
}
