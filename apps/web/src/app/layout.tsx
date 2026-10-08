import type { ReactElement, ReactNode } from 'react'
import './globals.css'
import { fonts } from '@serpdirectory/design-system/lib/fonts'
import { Footer } from '@/components/layout/footer'
import { Header } from '@/components/layout/header'
import { RootAppShell, rootLayoutMetadata } from '@/components/layout/root-shell'
import { siteConfig } from '@/lib/site/site-config'
import { siteCopy } from '@/lib/site/site-copy'
import { DrawerSignOutButton, HeaderSignOutButton } from '@/components/auth/sign-out-button'
import { PublicChrome } from '@/components/layout/public-chrome'
import { getHeaderAuthState } from '@/lib/auth/header-state'
import { getActiveCategories } from '@/lib/catalog/repository'
import { analyticsForRequest } from '@/lib/environment/request-environment'

export const metadata = rootLayoutMetadata
export const dynamic = 'force-dynamic'

type RootLayoutProps = {
  children: ReactNode
}

export default async function RootLayout({ children }: RootLayoutProps): Promise<ReactElement> {
  // Analytics load only on the public production site, never on local, staging, or the
  // production Worker's workers.dev host (docs/ARCHITECTURE.md#environments-and-hosts).
  const [authState, activeCategories, analytics] = await Promise.all([
    getHeaderAuthState(),
    getActiveCategories(),
    analyticsForRequest()
  ])
  const activeCategorySlugs = activeCategories.map(category => category.slug)

  return (
    <RootAppShell
      bodyClassName={fonts}
      cloudflareWebAnalyticsToken={analytics.cloudflareWebAnalyticsToken}
      feedTitle={`${siteConfig.name} - New ${siteCopy.listingName.pluralTitle}`}
      footer={
        <PublicChrome>
          <Footer />
        </PublicChrome>
      }
      gtmId={analytics.gtmId}
      header={
        <PublicChrome>
          <Header
            activeCategorySlugs={activeCategorySlugs}
            authState={authState}
            desktopSignOutButton={<HeaderSignOutButton />}
            mobileSignOutButton={<DrawerSignOutButton />}
          />
        </PublicChrome>
      }
    >
      {children}
    </RootAppShell>
  )
}
