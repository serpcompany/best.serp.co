'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * The public header and footer, left out on `/account`, which renders its own dashboard shell
 * (the #70 account mockups: shadcn dashboard-01). The root layout wraps both in this.
 */
export function PublicChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return isDashboardPath(pathname) ? null : children
}

export function isDashboardPath(pathname: string | null): boolean {
  return /^\/account(?:\/|$)/iu.test(pathname ?? '')
}
