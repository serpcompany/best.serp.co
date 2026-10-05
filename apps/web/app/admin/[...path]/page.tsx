import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/server'

/** Unknown `/admin/*` pages: 401 or 403 unless the visitor is an admin, then 404. */
export const dynamic = 'force-dynamic'

export default async function UnknownAdminPage(): Promise<never> {
  await requireAdmin()
  notFound()
}
