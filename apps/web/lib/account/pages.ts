import 'server-only'

import { redirect } from 'next/navigation'
import type { SessionUser } from '@/lib/auth/guards'
import { getSessionUser } from '@/lib/auth/server'
import { requireRouteFeature } from '@/lib/route-feature-gates'

/**
 * The signed-in user for an `/account` page (#65). Signed-out visitors go to `/login` and come
 * back to `path`. Every account page calls it, and every read after it is scoped to this user
 * (`lib/account/runtime.ts`); the architecture guard requires the call.
 */
export async function requireAccountUser(path: string): Promise<SessionUser> {
  requireRouteFeature('showAuth')
  const user = await getSessionUser()
  if (!user) redirect(`/login/?callbackUrl=${encodeURIComponent(path)}`)
  return user
}
