import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { AdminShell } from '@/components/admin/admin-shell'
import { getAdminReads } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'
import { features } from '@/lib/features'

/**
 * The admin panel shell (#64, sidebar-07 from the #70 mockups). Every page below it also calls
 * `requireAdmin()` itself; the Worker's Cloudflare Access and session gate runs first.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { follow: false, index: false, nocache: true },
  title: { default: 'Admin', template: '%s · Admin' }
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireAdmin()
  const counts = await (await getAdminReads()).reviewQueueCounts()
  return (
    <AdminShell
      queueCount={counts.waiting}
      showOrders={features.orders}
      user={{ email: user.email, name: user.name }}
    >
      {children}
    </AdminShell>
  )
}
