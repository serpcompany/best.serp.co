'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * The public header and footer, left out on the dashboards, which render their own shells:
 * `/account` (the #70 account mockups, shadcn dashboard-01, #60) and `/admin` (sidebar-07,
 * #64). The root layout wraps both in this.
 */
export function PublicChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return isDashboardPath(pathname) ? null : children
}

export function isDashboardPath(pathname: string | null): boolean {
  return /^\/(?:account|admin)(?:\/|$)/iu.test(pathname ?? '')
}
