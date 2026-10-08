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
import { useCloseMobileSidebar } from './nav-main'

export interface DashboardLink {
  title: string
  href: string
  icon: LucideIcon
}

/** dashboard-01's NavSecondary: small utility links, usually pinned with `className="mt-auto"`. */
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
