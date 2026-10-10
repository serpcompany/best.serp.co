'use client'

import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentProps, ReactNode } from 'react'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

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

/** serplists' `FULL_SIZE_TARGET_CLASS`: its sidebar rows are 44px touch targets. */
export const FULL_SIZE_TARGET_CLASS = 'h-11'

/** Centres a count or "Soon" badge on a full-size row (stock centres it on an 8-high row). */
const ROW_BADGE_CLASS = 'peer-data-[size=default]/menu-button:top-3'

/**
 * serplists' `AppSidebar` rows: an optional primary "quick create" row over the section rows, in
 * one group. Sections without an `href` keep their full colour with a subtle "Soon" badge,
 * instead of looking disabled.
 */
export function NavMain({
  items,
  quickAction,
  className,
  ...props
}: {
  items: readonly DashboardNavItem[]
  quickAction?: DashboardQuickAction
} & ComponentProps<typeof SidebarGroup>) {
  const close = useCloseMobileSidebar()
  const pathname = usePathname()
  return (
    <SidebarGroup className={className} {...props}>
      <SidebarGroupContent className="flex flex-col gap-2">
        {quickAction ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={quickAction.title}
                className={cn(
                  FULL_SIZE_TARGET_CLASS,
                  'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground'
                )}
                render={<Link href={quickAction.href} onClick={close} />}
              >
                {quickAction.icon ? <quickAction.icon /> : null}
                <span>{quickAction.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        <SidebarMenu>
          {items.map(item => {
            const active = item.href
              ? (item.isActive ?? isNavItemActive(pathname, item.href, item.exact))
              : false
            return (
              <SidebarMenuItem key={item.title}>
                {item.href ? (
                  <SidebarMenuButton
                    className={FULL_SIZE_TARGET_CLASS}
                    isActive={active}
                    tooltip={item.title}
                    render={
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        onClick={close}
                      />
                    }
                  >
                    {item.icon ? <item.icon /> : null}
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    tooltip={`${item.title}: coming soon`}
                    className={cn(
                      FULL_SIZE_TARGET_CLASS,
                      'cursor-default hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground'
                    )}
                    render={<span />}
                  >
                    {item.icon ? <item.icon /> : null}
                    <span>
                      {item.title}
                      <span className="sr-only"> (coming soon)</span>
                    </span>
                  </SidebarMenuButton>
                )}
                {item.href ? (
                  item.badge != null ? (
                    <SidebarMenuBadge className={ROW_BADGE_CLASS}>{item.badge}</SidebarMenuBadge>
                  ) : null
                ) : (
                  <SidebarMenuBadge
                    aria-hidden="true"
                    className={cn(
                      ROW_BADGE_CLASS,
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
  )
}
