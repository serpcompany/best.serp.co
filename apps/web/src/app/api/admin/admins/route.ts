import { addAdmin, removeAdmin } from '@/lib/admin/decisions'
import { runAdminDecision } from '@/lib/admin/requests'
import { adminEmailSchema } from '@/lib/admin/schemas'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * The admin allowlist (#64 screen 14): `POST` adds an email, `DELETE` removes one. The last
 * admin can never be removed; the plan refuses it inside the batch.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, adminEmailSchema, addAdmin)
}

export async function DELETE(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, adminEmailSchema, removeAdmin)
}
