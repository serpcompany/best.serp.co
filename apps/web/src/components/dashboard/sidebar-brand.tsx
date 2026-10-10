'use client'

import Link from 'next/link'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
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

/** serplists' `BrandMark`: the logo tile, with the SERP mark for its grid icon. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground',
        className
      )}
    >
      <SerpMark className="size-4" />
    </span>
  )
}

/**
 * The sidebar's top row, serplists' `AppSidebar` brand: the logo tile and the name. With a
 * `subtitle` (for example "Admin"), the name sits over it, as in sidebar-07.
 */
export function SidebarBrand({
  href,
  title,
  subtitle
}: {
  href: string
  title: string
  subtitle?: string
}) {
  const close = useCloseMobileSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" tooltip={title} render={<Link href={href} onClick={close} />}>
          <BrandMark className="size-8 rounded-lg" />
          {subtitle ? (
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-semibold">{title}</span>
              <span className="truncate text-xs">{subtitle}</span>
            </span>
          ) : (
            <span className="truncate font-semibold">{title}</span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
