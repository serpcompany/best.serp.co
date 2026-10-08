'use client'

import Link from 'next/link'
import React, { type ReactNode } from 'react'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useCloseMobileSidebar } from './nav-main'

const SERP_MARK =
  'M 127.62 540.68 C 255.64 429.97 383.70 319.31 511.76 208.65 C 639.74 319.23 767.70 429.86 895.69 540.45 C 895.70 631.71 895.73 722.97 895.64 814.23 C 719.72 662.17 543.76 510.14 367.81 358.10 C 398.86 414.80 429.83 471.54 460.92 528.22 C 349.85 623.79 238.69 719.27 127.67 814.91 C 127.66 723.50 127.67 632.09 127.62 540.68 Z'

/** The SERP mark from `apps/web/public/logo.svg`, in the current text colour. */
export function SerpMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <path fill="currentColor" d={SERP_MARK} />
    </svg>
  )
}

/**
 * The sidebar's top entry. Without `subtitle` it is dashboard-01's logo and name; with one it
 * is sidebar-07's square logo tile over a name and a second line (for example "Admin").
 */
export function SidebarBrand({
  href,
  title,
  subtitle,
  logo
}: {
  href: string
  title: string
  subtitle?: string
  logo?: ReactNode
}) {
  const close = useCloseMobileSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {subtitle ? (
          <SidebarMenuButton size="lg" asChild>
            <Link href={href} onClick={close}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                {logo ?? <SerpMark className="size-4" />}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{title}</span>
                <span className="truncate text-xs">{subtitle}</span>
              </div>
            </Link>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
            <Link href={href} onClick={close}>
              {logo ?? <SerpMark className="!size-5" />}
              <span className="text-base font-semibold">{title}</span>
            </Link>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
