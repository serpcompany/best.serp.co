import type { ReactNode } from 'react'
import { DrawerSignOutButton, HeaderSignOutButton } from '@/components/auth/sign-out-button'
import { Footer } from '@/components/layout/footer'
import { Header } from '@/components/layout/header'
import { getHeaderAuthState } from '@/lib/auth/header-state'
import { getActiveCategories } from '@/lib/catalog/repository'

/**
 * The public site's header, footer, and the page's one `<main>`: the `(site)` layout and the
 * root 404 page render it. The dashboards (`(dashboard)`) have their own shells instead.
 */
export async function SiteChrome({ children }: { children: ReactNode }) {
  const [authState, activeCategories] = await Promise.all([
    getHeaderAuthState(),
    getActiveCategories()
  ])
  return (
    <div className="flex min-h-screen flex-col">
      <Header
        activeCategorySlugs={activeCategories.map(category => category.slug)}
        authState={authState}
        desktopSignOutButton={<HeaderSignOutButton />}
        mobileSignOutButton={<DrawerSignOutButton />}
      />
      <main className="flex flex-1 flex-col">{children}</main>
      <Footer />
    </div>
  )
}
