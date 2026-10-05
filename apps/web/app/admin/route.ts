import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * Placeholder for the admin panel (serpcompany/best.serp.co#64), whose screens wait for mockup
 * approval in #70: no markup, only the gate. Admins get 204 No Content; everyone else gets the
 * same 401 or 403 every admin route answers (Cloudflare Access is checked earlier by the
 * Worker entry).
 */
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return new Response(null, {
    headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
    status: 204
  })
}

export const GET = handle
export const HEAD = handle
