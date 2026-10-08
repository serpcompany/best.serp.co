import { DashboardPageHeader } from '@serpdirectory/web-core/dashboard/page-header'
import type { Metadata } from 'next'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { AdminsManager } from '@/components/admin/admins-manager'
import { getAdminReads } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'

/** The admin allowlist (#64 screen 14). */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Admins' }

export default async function AdminsPage() {
  const user = await requireAdmin()
  const admins = await (await getAdminReads()).listAdmins()
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Admins' }]} />

      <DashboardPageHeader
        title="Admins"
        description="People on this list can open /admin after signing in. In production, Cloudflare Access also has to let them through."
      />
      <AdminsManager admins={admins} currentEmail={user.email.trim().toLowerCase()} />
    </>
  )
}
