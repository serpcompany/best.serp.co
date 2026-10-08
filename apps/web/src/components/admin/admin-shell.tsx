'use client'

import { Box, CircleUser, ExternalLink, Inbox, Receipt, Users } from 'lucide-react'
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
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The admin shell (#64): shadcn sidebar-07 (`collapsible="icon"` with a rail, the logo tile,
 * NavUser with the switch to the account area), built from the shared dashboard pieces in
 * `@/components/dashboard/*` like the account shell. The layout renders it once, so
 * the sidebar keeps its state across admin pages; each page names its breadcrumb with
 * `AdminCrumbs`. Unbuilt areas are hidden: the Inbox arrives with #73 and Orders with #68
 * (`showOrders`).
 */

const CrumbsContext = createContext<{
  crumbs: readonly DashboardCrumb[] | null
  setCrumbs: (crumbs: readonly DashboardCrumb[] | null) => void
} | null>(null)

/** The breadcrumb for pages without their own, from the path. */
function defaultCrumbs(pathname: string): DashboardCrumb[] {
  const root = { href: '/admin/', label: 'Admin' }
  if (pathname.startsWith('/admin/listings/'))
    return [root, { href: '/admin/listings/', label: 'Listings' }]
  if (pathname.startsWith('/admin/admins/')) return [root, { label: 'Admins' }]
  return [root, { href: '/admin/submissions/', label: 'Review queue' }]
}

/** Sets this page's breadcrumb in the admin header. */
export function AdminCrumbs({ crumbs }: { crumbs: readonly DashboardCrumb[] }) {
  const context = useContext(CrumbsContext)
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    context?.setCrumbs(crumbs)
    return () => context?.setCrumbs(null)
  }, [key])
  return null
}

function AdminHeader() {
  const pathname = usePathname() ?? ''
  const context = useContext(CrumbsContext)
  return (
    <SiteHeader
      crumbs={context?.crumbs ?? defaultCrumbs(pathname.toLowerCase())}
      actions={
        <>
          <a
            href="/"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'hidden sm:flex')}
          >
            View site
            <ExternalLink />
          </a>
          <ModeToggle />
        </>
      }
    />
  )
}

export function AdminShell({
  children,
  queueCount,
  showOrders,
  user
}: {
  children: ReactNode
  queueCount: number
  showOrders: boolean
  user: DashboardUser
}) {
  const pathname = usePathname()
  const [crumbs, setCrumbs] = useState<readonly DashboardCrumb[] | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const crumbsContext = useMemo(() => ({ crumbs, setCrumbs }), [crumbs])
  // NavMain marks the current section from the path; a revision belongs to the review queue.
  const nav: DashboardNavItem[] = [
    {
      badge: queueCount > 0 ? queueCount : undefined,
      href: '/admin/submissions/',
      icon: Inbox,
      isActive:
        isNavItemActive(pathname, '/admin/submissions/') ||
        isNavItemActive(pathname, '/admin/revisions/'),
      title: 'Review queue'
    },
    { href: '/admin/listings/', icon: Box, title: 'Listings' },
    ...(showOrders ? [{ href: '/admin/orders/', icon: Receipt, title: 'Orders' }] : []),
    { href: '/admin/admins/', icon: Users, title: 'Admins' }
  ]

  async function onSignOut() {
    setSigningOut(true)
    await signOut()
    window.location.assign('/')
  }

  return (
    <CrumbsContext.Provider value={crumbsContext}>
      <AppShell
        collapsible="icon"
        variant="sidebar"
        rail
        sidebarHeader={<SidebarBrand href="/admin/submissions/" title="SERP" subtitle="Admin" />}
        sidebarContent={
          <>
            <NavMain label="Admin" items={nav} />
            <NavSecondary
              className="mt-auto"
              items={[{ href: '/', icon: ExternalLink, title: 'View best.serp.co' }]}
            />
          </>
        }
        sidebarFooter={
          <NavUser
            user={user}
            links={[{ href: '/account/', icon: CircleUser, title: 'Switch to Account' }]}
            onSignOut={() => void onSignOut()}
            signingOut={signingOut}
          />
        }
        header={<AdminHeader />}
      >
        {children}
      </AppShell>
    </CrumbsContext.Provider>
  )
}
