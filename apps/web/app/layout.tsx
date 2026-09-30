import type { ReactElement, ReactNode } from 'react'
import './globals.css'
import { fonts } from '@serpdirectory/design-system/lib/fonts'
import { resolveGoogleTagManagerId } from '@serpdirectory/web-core/google-tag-manager'
import { Footer } from '@serpdirectory/web-core/layout/footer'
import { Header } from '@serpdirectory/web-core/layout/header'
import { RootAppShell, rootLayoutMetadata } from '@serpdirectory/web-core/root-shell'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { siteCopy } from '@serpdirectory/web-core/site-copy'
import { SignOutButton } from '@/components/auth/sign-out-button'
import { getHeaderAuthState } from '@/lib/auth'
import { getActiveCategories, getFeaturedListingCount } from '@/lib/catalog/repository'

export const metadata = rootLayoutMetadata
export const dynamic = 'force-dynamic'

type RootLayoutProps = {
  children: ReactNode
}

export default async function RootLayout({ children }: RootLayoutProps): Promise<ReactElement> {
  const gtmId = resolveGoogleTagManagerId(siteConfig)
  const [authState, activeCategories, featuredCount] = await Promise.all([
    getHeaderAuthState(),
    getActiveCategories(),
    getFeaturedListingCount()
  ])
  const activeCategorySlugs = activeCategories.map(category => category.slug)

  return (
    <RootAppShell
      bodyClassName={fonts}
      feedTitle={`${siteConfig.name} - New ${siteCopy.listingName.pluralTitle}`}
      footer={<Footer />}
      gtmId={gtmId}
      header={
        <Header
          activeCategorySlugs={activeCategorySlugs}
          authState={authState}
          desktopSignOutButton={
            <SignOutButton className="hidden sm:inline-flex rounded-none text-sm font-bold h-9 px-4" />
          }
          featuredCount={featuredCount}
          mobileSignOutButton={
            <SignOutButton className="w-full justify-start rounded-md px-2 py-1.5 text-sm font-normal" />
          }
        />
      }
    >
      {children}
    </RootAppShell>
  )
}
