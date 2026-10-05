'use client'

import { Button } from '@serpdirectory/design-system/button'
import { AppShell } from '@serpdirectory/web-core/dashboard/app-shell'
import { type DashboardNavItem, NavMain } from '@serpdirectory/web-core/dashboard/nav-main'
import { NavSecondary } from '@serpdirectory/web-core/dashboard/nav-secondary'
import { type DashboardUser, NavUser } from '@serpdirectory/web-core/dashboard/nav-user'
import { SidebarBrand } from '@serpdirectory/web-core/dashboard/sidebar-brand'
import { type DashboardCrumb, SiteHeader } from '@serpdirectory/web-core/dashboard/site-header'
import { ModeToggle } from '@serpdirectory/web-core/mode-toggle'
import { getRoute } from '@serpdirectory/web-core/routes'
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
import { type ReactNode, useState } from 'react'
import { signOut } from '@/components/auth/sign-in-api'

/**
 * The account dashboard shell from the #70 mockups (screen 5): shadcn dashboard-01, built from
 * the shared dashboard pieces in `@serpdirectory/web-core/dashboard/*` (the admin panel reuses
 * them with sidebar-07's options). Only Overview exists until #65 builds the other sections,
 * so they show a "Soon" badge.
 */

export type AccountUser = DashboardUser

const NAV: readonly DashboardNavItem[] = [
  { href: getRoute('account'), icon: LayoutDashboard, isActive: true, title: 'Overview' },
  { icon: FileText, title: 'Submissions' },
  { icon: Box, title: 'Listings' },
  { icon: MessageSquare, title: 'Messages' },
  { icon: Settings, title: 'Settings' }
]

const SECONDARY = [
  { href: getRoute('home'), icon: ExternalLink, title: 'View best.serp.co' },
  // Until in-dashboard messages (#73) exist, "Message us" opens the contact page.
  { href: getRoute('contact'), icon: MessageSquare, title: 'Message us' }
] as const

export function AccountShell({
  children,
  crumbs = [{ href: getRoute('account'), label: 'Account' }, { label: 'Overview' }],
  user
}: {
  children: ReactNode
  crumbs?: readonly DashboardCrumb[]
  user: AccountUser
}) {
  const [signingOut, setSigningOut] = useState(false)

  async function onSignOut() {
    setSigningOut(true)
    await signOut()
    window.location.assign(getRoute('home'))
  }

  return (
    <AppShell
      sidebarHeader={<SidebarBrand href={getRoute('account')} title="SERP" />}
      sidebarContent={
        <>
          <NavMain
            items={NAV}
            label="Account"
            quickAction={{ href: getRoute('submit'), icon: PlusCircle, title: 'Submit a product' }}
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
      header={
        <SiteHeader
          crumbs={crumbs}
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
      }
    >
      {children}
    </AppShell>
  )
}
