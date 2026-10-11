import { addAdmin, removeAdmin } from '@/lib/admin/decisions'
import { runAdminDecision } from '@/lib/admin/requests'
import { adminEmailSchema } from '@/lib/admin/schemas'
import { type Authorization, authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * The admin allowlist (#64 screen 14): `POST` adds an email, `DELETE` removes one. The last
 * admin can never be removed; the plan refuses it inside the batch. Only a person's session
 * changes the allowlist: staging's admin key (#408), which has no session, gets 403 here even if
 * it reached this route under another path.
 */
export const dynamic = 'force-dynamic'

async function authorizeAllowlistChange(request: Request): Promise<Authorization> {
  const authorization = await authorizeAdminRequest(request)
  if (authorization.ok && authorization.sessionId === null) {
    return { ok: false, reason: 'admin_key_forbidden', status: 403 }
  }
  return authorization
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeAllowlistChange(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, adminEmailSchema, addAdmin)
}

export async function DELETE(request: Request): Promise<Response> {
  const authorization = await authorizeAllowlistChange(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, adminEmailSchema, removeAdmin)
}
