'use client'

import {
  Box,
  ExternalLink,
  FileText,
  LayoutDashboard,
  MessageSquare,
  PlusCircle,
  Settings
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { signOut } from '@/components/auth/sign-in-api'
import { AppShell } from '@/components/dashboard/app-shell'
import { type DashboardNavItem, isNavItemActive, NavMain } from '@/components/dashboard/nav-main'
import { NavSecondary } from '@/components/dashboard/nav-secondary'
import { type DashboardUser, NavUser } from '@/components/dashboard/nav-user'
import { SidebarBrand } from '@/components/dashboard/sidebar-brand'
import { type DashboardCrumb, SiteHeader } from '@/components/dashboard/site-header'
import { ModeToggle } from '@/components/layout/mode-toggle'
import { Button } from '@/components/ui/button'
import { getRoute } from '@/lib/routing/routes'

/**
 * The account dashboard shell from the #70 mockups (screens 5 to 7): shadcn dashboard-01, built
 * from the shared dashboard pieces in `@/components/dashboard/*` (the admin panel
 * reuses them with sidebar-07's options). The layout renders it once; each page names its
 * breadcrumb with `AccountCrumbs`. Messages (#73) and Settings are not built yet, so they show a
 * "Soon" badge.
 */

export type AccountUser = DashboardUser

const CrumbsContext = createContext<{
  crumbs: readonly DashboardCrumb[] | null
  setCrumbs: (crumbs: readonly DashboardCrumb[] | null) => void
} | null>(null)

const ACCOUNT = { href: getRoute('account'), label: 'Account' } as const

/** The breadcrumb for pages without their own, from the path. */
function defaultCrumbs(pathname: string): DashboardCrumb[] {
  if (pathname.startsWith('/account/submissions/')) return [ACCOUNT, { label: 'Submissions' }]
  if (pathname.startsWith('/account/listings/')) return [ACCOUNT, { label: 'Listings' }]
  return [ACCOUNT, { label: 'Overview' }]
}

/** Sets this page's breadcrumb in the account header. */
export function AccountCrumbs({ crumbs }: { crumbs: readonly DashboardCrumb[] }) {
  const context = useContext(CrumbsContext)
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    context?.setCrumbs(crumbs)
    return () => context?.setCrumbs(null)
  }, [key])
  return null
}

function AccountHeader() {
  const pathname = usePathname() ?? ''
  const context = useContext(CrumbsContext)
  return (
    <SiteHeader
      crumbs={context?.crumbs ?? defaultCrumbs(pathname.toLowerCase())}
      actions={
        <>
          <Button variant="ghost" asChild size="sm" className="hidden sm:flex">
            <Link href={getRoute('home')}>
              View site
              <ExternalLink />
            </Link>
          </Button>
          <ModeToggle />
        </>
      }
    />
  )
}

const SECONDARY = [
  { href: getRoute('home'), icon: ExternalLink, title: 'View best.serp.co' },
  // Until in-dashboard messages (#73) exist, "Message us" opens the contact page.
  { href: getRoute('contact'), icon: MessageSquare, title: 'Message us' }
] as const

export function AccountShell({
  children,
  submissionsNeedingAction = 0,
  user
}: {
  children: ReactNode
  /** The Submissions entry's count: the user's submissions that need their action. */
  submissionsNeedingAction?: number
  user: AccountUser
}) {
  const pathname = usePathname()
  const [crumbs, setCrumbs] = useState<readonly DashboardCrumb[] | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const crumbsContext = useMemo(() => ({ crumbs, setCrumbs }), [crumbs])
  const nav: DashboardNavItem[] = [
    { exact: true, href: getRoute('account'), icon: LayoutDashboard, title: 'Overview' },
    {
      badge: submissionsNeedingAction > 0 ? submissionsNeedingAction : undefined,
      href: '/account/submissions/',
      icon: FileText,
      isActive: isNavItemActive(pathname, '/account/submissions/'),
      title: 'Submissions'
    },
    { href: '/account/listings/', icon: Box, title: 'Listings' },
    { icon: MessageSquare, title: 'Messages' },
    { icon: Settings, title: 'Settings' }
  ]

  async function onSignOut() {
    setSigningOut(true)
    await signOut()
    window.location.assign(getRoute('home'))
  }

  return (
    <CrumbsContext.Provider value={crumbsContext}>
      <AppShell
        sidebarHeader={<SidebarBrand href={getRoute('account')} title="SERP" />}
        sidebarContent={
          <>
            <NavMain
              items={nav}
              label="Account"
              quickAction={{
                href: getRoute('submit'),
                icon: PlusCircle,
                title: 'Submit a product'
              }}
            />
            <NavSecondary items={SECONDARY} className="mt-auto" />
          </>
        }
        sidebarFooter={
          <NavUser
            user={user}
            links={[{ href: getRoute('home'), icon: ExternalLink, title: 'View best.serp.co' }]}
            onSignOut={() => void onSignOut()}
            signingOut={signingOut}
          />
        }
        header={<AccountHeader />}
      >
        {children}
      </AppShell>
    </CrumbsContext.Provider>
  )
}
