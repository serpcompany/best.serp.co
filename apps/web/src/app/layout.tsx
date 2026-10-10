import type { Metadata } from 'next'
import type { ReactElement, ReactNode } from 'react'
import './globals.css'
import { RootAppShell, rootLayoutMetadata } from '@/components/layout/root-shell'
import { analyticsForRequest } from '@/lib/environment/request-environment'
import { fonts } from '@/lib/fonts'
import { siteConfig } from '@/lib/site/site-config'
import { siteCopy } from '@/lib/site/site-copy'

export function generateMetadata(): Metadata {
  return rootLayoutMetadata()
}
export const dynamic = 'force-dynamic'

type RootLayoutProps = {
  children: ReactNode
}

/**
 * The document and its providers. The public chrome is the `(site)` layout's, and the
 * dashboards (`(dashboard)`) render their own shells.
 */
export default async function RootLayout({ children }: RootLayoutProps): Promise<ReactElement> {
  // Analytics load only on the public production site, never on local, staging, or the
  // production Worker's workers.dev host (docs/architecture.md#environments-and-hosts).
  const analytics = await analyticsForRequest()

  return (
    <RootAppShell
      cloudflareWebAnalyticsToken={analytics.cloudflareWebAnalyticsToken}
      feedTitle={`${siteConfig.name} - New ${siteCopy.listingName.pluralTitle}`}
      gtmId={analytics.gtmId}
      htmlClassName={fonts}
    >
      {children}
    </RootAppShell>
  )
}
