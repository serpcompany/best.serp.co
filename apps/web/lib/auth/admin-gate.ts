/**
 * The Worker entry's gate for `/admin` and `/api/admin` (serpcompany/best.serp.co#60), applied
 * by `lib/worker/handle-request.ts` before the edge cache and before Next.js loads:
 *
 * 1. Cloudflare Access (`cloudflare-access.ts`): 503 when production has no Access
 *    configuration, 403 without a valid Access JWT.
 * 2. A request without a Better Auth session cookie is 401.
 *
 * Requests that pass still reach the pages and route handlers, which authorize the session
 * itself with `requireAdmin()` (401 for an invalid session, 403 for a non-admin). The gate makes
 * every admin path fail closed even where no route exists, and keeps anonymous traffic away
 * from Next.js and D1.
 */
import { type AccessEnv, type VerifyAccessOptions, verifyAccessRequest } from './cloudflare-access'
import { hasSessionCookie } from './cookies'

const ADMIN_PREFIXES = ['/admin', '/api/admin']

/**
 * True for `/admin`, `/api/admin`, and everything below them, in any letter case, with
 * percent-encoding and repeated slashes resolved the way a router might. A path that cannot
 * be decoded is treated as an admin path.
 */
export function isAdminPath(pathname: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }
  const normalized = decoded.replace(/[\\/]+/gu, '/').toLowerCase()
  return ADMIN_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

function denied(status: 401 | 403 | 503, message: string): Response {
  return new Response(`${message}\n`, {
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow'
    },
    status
  })
}

/** A 401, 403, or 503 for an admin request that may not proceed, otherwise null. */
export async function adminGate(
  request: Request,
  env: AccessEnv,
  options: VerifyAccessOptions = {}
): Promise<Response | null> {
  if (!isAdminPath(new URL(request.url).pathname)) return null
  const access = await verifyAccessRequest(request, env, options)
  if (access.status === 'not-configured') return denied(503, 'Access not configured')
  if (access.status === 'missing' || access.status === 'invalid') return denied(403, 'Forbidden')
  if (!hasSessionCookie(request.headers.get('cookie'))) return denied(401, 'Unauthorized')
  return null
}
