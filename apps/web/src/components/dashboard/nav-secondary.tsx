'use client'

import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import type { ComponentProps } from 'react'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import { FULL_SIZE_TARGET_CLASS, useCloseMobileSidebar } from './nav-main'

export interface DashboardLink {
  title: string
  href: string
  icon: LucideIcon
}

/**
 * serplists' secondary `AppSidebar` group: utility rows, usually pinned with
 * `className="mt-auto"`.
 */
export function NavSecondary({
  items,
  ...props
}: { items: readonly DashboardLink[] } & ComponentProps<typeof SidebarGroup>) {
  const close = useCloseMobileSidebar()
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(item => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                className={FULL_SIZE_TARGET_CLASS}
                tooltip={item.title}
                render={<Link href={item.href} onClick={close} />}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
