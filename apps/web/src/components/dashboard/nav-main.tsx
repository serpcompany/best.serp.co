'use client'

import { cn } from '@/lib/utils'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React, { type ComponentProps, type ReactNode } from 'react'

export interface DashboardNavItem {
  title: string
  icon?: LucideIcon
  /** Omit for a section that is not built yet; it shows a "Soon" badge and does not link. */
  href?: string
  /** Defaults to matching the current path: exact for `exact`, else the href or a sub-path. */
  isActive?: boolean
  /** Match only the exact path, e.g. an Overview at the area's root. */
  exact?: boolean
  /** A count or label on the right, e.g. unread messages (SidebarMenuBadge). */
  badge?: ReactNode
}

export interface DashboardQuickAction {
  title: string
  href: string
  icon?: LucideIcon
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') : path
}

/** Whether `href` is the current page: the exact path, or (unless `exact`) a page under it. */
export function isNavItemActive(pathname: string | null, href: string, exact = false): boolean {
  if (!pathname) return false
  const current = normalizePath(pathname)
  const target = normalizePath(href)
  if (current === target) return true
  return !exact && target !== '/' && current.startsWith(`${target}/`)
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
  const pathname = usePathname()
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
        {/* /80 rather than stock /70, so the label reaches 4.5:1 on the light sidebar. */}
        {label ? (
          <SidebarGroupLabel className="text-sidebar-foreground/80">{label}</SidebarGroupLabel>
        ) : null}
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map(item => {
              const active = item.href
                ? (item.isActive ?? isNavItemActive(pathname, item.href, item.exact))
                : false
              return (
                <SidebarMenuItem key={item.title}>
                  {item.href ? (
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
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
                        // /80 keeps the 11px label at 4.5:1 or more on the light sidebar.
                        'border border-sidebar-border px-1.5 text-[11px] font-normal text-sidebar-foreground/80',
                        'peer-hover/menu-button:text-sidebar-foreground/80'
                      )}
                    >
                      Soon
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}
