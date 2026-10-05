'use client'

import { cn } from '@serpdirectory/design-system/lib/utils'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail
} from '@serpdirectory/design-system/sidebar'
import type { CSSProperties, ReactNode } from 'react'

/**
 * The signed-in dashboard frame shared by `/account` (shadcn dashboard-01: `variant="inset"`,
 * `collapsible="offcanvas"`) and `/admin` (shadcn sidebar-07: `collapsible="icon"` with a
 * rail). The sidebar becomes a Sheet below the `md` breakpoint. Pages render inside the inset
 * card, under `header` (usually `SiteHeader`).
 */
export interface AppShellProps {
  children: ReactNode
  /** Usually `SiteHeader`. */
  header: ReactNode
  sidebarContent: ReactNode
  sidebarFooter?: ReactNode
  sidebarHeader?: ReactNode
  variant?: 'inset' | 'sidebar' | 'floating'
  collapsible?: 'offcanvas' | 'icon' | 'none'
  /** sidebar-07's edge handle for toggling the sidebar. */
  rail?: boolean
  /** Extra classes for the content column inside the inset. */
  contentClassName?: string
}

export function AppShell({
  children,
  collapsible = 'offcanvas',
  contentClassName,
  header,
  rail = false,
  sidebarContent,
  sidebarFooter,
  sidebarHeader,
  variant = 'inset'
}: AppShellProps) {
  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 64)',
          '--header-height': 'calc(var(--spacing) * 12)'
        } as CSSProperties
      }
    >
      <Sidebar collapsible={collapsible} variant={variant}>
        {sidebarHeader ? <SidebarHeader>{sidebarHeader}</SidebarHeader> : null}
        <SidebarContent>{sidebarContent}</SidebarContent>
        {sidebarFooter ? <SidebarFooter>{sidebarFooter}</SidebarFooter> : null}
        {rail ? <SidebarRail /> : null}
      </Sidebar>
      {/*
        bg-card: the site's --background is 99% white and the light sidebar 98%, so the inset
        card would not stand out; dashboard-01 has a white card on the sidebar colour.
      */}
      <SidebarInset className="bg-card">
        {header}
        <div
          className={cn(
            '@container/main flex flex-1 flex-col gap-6 px-4 py-6 lg:px-6',
            contentClassName
          )}
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
