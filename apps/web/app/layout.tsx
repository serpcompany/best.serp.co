import type { ReactElement, ReactNode } from 'react'
import './globals.css'
import { fonts } from '@serpdirectory/design-system/lib/fonts'
import { Footer } from '@serpdirectory/web-core/layout/footer'
import { Header } from '@serpdirectory/web-core/layout/header'
import { RootAppShell, rootLayoutMetadata } from '@serpdirectory/web-core/root-shell'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { siteCopy } from '@serpdirectory/web-core/site-copy'
import { getHeaderAuthState } from '@/lib/auth/header-state'
import { getActiveCategories } from '@/lib/catalog/repository'
import { googleTagManagerIdForRequest } from '@/lib/environment/request-environment'

export const metadata = rootLayoutMetadata
export const dynamic = 'force-dynamic'

type RootLayoutProps = {
  children: ReactNode
}

export default async function RootLayout({ children }: RootLayoutProps): Promise<ReactElement> {
  // Analytics load only on the public production site, never on local, staging, or the
  // production Worker's workers.dev host (docs/ARCHITECTURE.md#environments-and-hosts).
  const [authState, activeCategories, gtmId] = await Promise.all([
    getHeaderAuthState(),
    getActiveCategories(),
    googleTagManagerIdForRequest()
  ])
  const activeCategorySlugs = activeCategories.map(category => category.slug)

  return (
    <RootAppShell
      bodyClassName={fonts}
      feedTitle={`${siteConfig.name} - New ${siteCopy.listingName.pluralTitle}`}
      footer={<Footer />}
      gtmId={gtmId}
      header={<Header activeCategorySlugs={activeCategorySlugs} authState={authState} />}
    >
      {children}
    </RootAppShell>
  )
}
