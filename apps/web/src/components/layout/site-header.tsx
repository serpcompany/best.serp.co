import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import type { HeaderAuthState } from '@/lib/auth/header-auth-state'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { AccountMenu } from './account-menu'
import { PageContainer } from './page-shell'
import { SiteMobileNav } from './site-mobile-nav'
import { SiteNavigationMenu } from './site-navigation-menu'

/**
 * The public site's header (serplists' `SiteHeader`, #256): the menu on phones and the site
 * name on the left, the navigation in the middle, and Submit with the account menu on the right,
 * as zenbujapanese.com's (#286). There is no search in the header (#253).
 */
export function SiteHeader({ authState }: { authState: HeaderAuthState }) {
  return (
    <header className="sticky top-0 z-50 border-b bg-background">
      <PageContainer width="shell" className="flex h-14 items-center gap-4">
        <div className="flex flex-1 items-center gap-2">
          <SiteMobileNav authState={authState} />
          <Link href={getRoute('home')} className="text-sm font-semibold whitespace-nowrap">
            {siteConfig.name}
          </Link>
        </div>

        <SiteNavigationMenu className="hidden md:flex" />

        {/* zenbujapanese.com's right side (#286): the primary action, then the account menu. */}
        <div className="flex flex-1 items-center justify-end gap-2">
          <Link href={getRoute('submit')} className={buttonVariants({ size: 'lg' })}>
            {siteCopy.submitLabel}
          </Link>
          <AccountMenu authState={authState} className="hidden md:inline-flex" />
        </div>
      </PageContainer>
    </header>
  )
}
