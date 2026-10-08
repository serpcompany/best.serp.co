'use client'

import React, { type CSSProperties, type ReactNode } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  useSidebar
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

/**
 * The signed-in dashboard frame shared by `/account` (shadcn dashboard-01: `variant="inset"`,
 * `collapsible="offcanvas"`) and `/admin` (shadcn sidebar-07: `collapsible="icon"` with a
 * rail). The sidebar becomes a Sheet below the `md` breakpoint. Pages render inside the inset,
 * under `header` (usually `SiteHeader`).
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
  /** Whether the desktop sidebar starts expanded (default true). */
  defaultOpen?: boolean
  /** Extra classes for the content column inside the inset. */
  contentClassName?: string
}

export function AppShell({
  children,
  collapsible = 'offcanvas',
  contentClassName,
  defaultOpen = true,
  header,
  rail = false,
  sidebarContent,
  sidebarFooter,
  sidebarHeader,
  variant = 'inset'
}: AppShellProps) {
  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 64)',
          '--header-height': 'calc(var(--spacing) * 12)'
        } as CSSProperties
      }
    >
      <Sidebar collapsible={collapsible} variant={variant}>
        <SidebarPanel collapsible={collapsible}>
          {sidebarHeader ? <SidebarHeader>{sidebarHeader}</SidebarHeader> : null}
          <SidebarContent>{sidebarContent}</SidebarContent>
          {sidebarFooter ? <SidebarFooter>{sidebarFooter}</SidebarFooter> : null}
        </SidebarPanel>
        {rail ? <SidebarRail /> : null}
      </Sidebar>
      {/*
        The inset variant is a card on the sidebar colour. The site's --background is 99% white
        and the light sidebar 98%, so that card uses bg-card (white), as dashboard-01 does.
      */}
      <SidebarInset className={variant === 'inset' ? 'bg-card' : undefined}>
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

/**
 * The sidebar's contents. When the desktop sidebar is collapsed off-canvas it is moved off
 * screen, so its links leave the tab order (`inert`); the rail stays outside, so it still
 * works. In icon mode the collapsed sidebar stays visible and usable.
 */
function SidebarPanel({
  children,
  collapsible
}: {
  children: ReactNode
  collapsible: AppShellProps['collapsible']
}) {
  const { isMobile, state } = useSidebar()
  const hidden = collapsible === 'offcanvas' && state === 'collapsed' && !isMobile
  return (
    <div className="contents" data-slot="sidebar-panel" inert={hidden || undefined}>
      {children}
    </div>
  )
}
