import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/server'

/** `/admin/` opens the review queue (#64); everyone else gets the admin gate's 401 or 403. */
export const dynamic = 'force-dynamic'

export default async function AdminHome(): Promise<never> {
  await requireAdmin()
  redirect('/admin/submissions/')
}
