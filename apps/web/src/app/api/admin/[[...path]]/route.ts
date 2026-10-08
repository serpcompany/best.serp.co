import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * Every `/api/admin/*` path without its own route: 401 or 403 unless the caller is an admin,
 * then 404. Admin API routes added later (#64) are more specific and call `requireAdmin()` or
 * `authorizeAdminRequest()` themselves; `scripts/architecture-guard.test.ts` enforces that.
 */
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return Response.json(
    { error: 'not_found', message: 'No such admin endpoint.' },
    { headers: { 'cache-control': 'private, no-store' }, status: 404 }
  )
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
