'use client'

import { cn } from '@serpdirectory/design-system/lib/utils'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@serpdirectory/design-system/sidebar'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import React, { type ComponentProps, type ReactNode } from 'react'

export interface DashboardNavItem {
  title: string
  icon?: LucideIcon
  /** Omit for a section that is not built yet; it shows a "Soon" badge and does not link. */
  href?: string
  isActive?: boolean
  /** A count or label on the right, e.g. unread messages (SidebarMenuBadge). */
  badge?: ReactNode
}

export interface DashboardQuickAction {
  title: string
  href: string
  icon?: LucideIcon
}

/** Closes the mobile Sheet after a link inside it is followed. */
export function useCloseMobileSidebar(): () => void {
  const { isMobile, setOpenMobile } = useSidebar()
  return () => {
    if (isMobile) setOpenMobile(false)
  }
}

/**
 * dashboard-01's NavMain: an optional primary "quick create" button, then the section links.
 * Sections without an `href` keep their full colour with a subtle "Soon" badge, instead of
 * looking disabled.
 */
export function NavMain({
  items,
  label,
  quickAction,
  className,
  ...props
}: {
  items: readonly DashboardNavItem[]
  label?: string
  quickAction?: DashboardQuickAction
} & ComponentProps<typeof SidebarGroup>) {
  const close = useCloseMobileSidebar()
  return (
    <>
      {quickAction ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={quickAction.title}
                  className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                >
                  <Link href={quickAction.href} onClick={close}>
                    {quickAction.icon ? <quickAction.icon /> : null}
                    <span>{quickAction.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      <SidebarGroup className={className} {...props}>
        {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map(item => (
              <SidebarMenuItem key={item.title}>
                {item.href ? (
                  <SidebarMenuButton asChild isActive={item.isActive} tooltip={item.title}>
                    <Link
                      href={item.href}
                      aria-current={item.isActive ? 'page' : undefined}
                      onClick={close}
                    >
                      {item.icon ? <item.icon /> : null}
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    asChild
                    tooltip={`${item.title}: coming soon`}
                    className="cursor-default hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
                  >
                    <span>
                      {item.icon ? <item.icon /> : null}
                      <span>
                        {item.title}
                        <span className="sr-only"> (coming soon)</span>
                      </span>
                    </span>
                  </SidebarMenuButton>
                )}
                {item.href ? (
                  item.badge != null ? (
                    <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                  ) : null
                ) : (
                  <SidebarMenuBadge
                    aria-hidden="true"
                    className={cn(
                      'border border-sidebar-border px-1.5 text-[11px] font-normal text-sidebar-foreground/70',
                      'peer-hover/menu-button:text-sidebar-foreground/70'
                    )}
                  >
                    Soon
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}
