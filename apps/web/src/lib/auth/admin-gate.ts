/**
 * The Worker entry's gate for `/admin` and `/api/admin` (serpcompany/best.serp.co#60), applied
 * by `lib/worker/handle-request.ts` before the edge cache and before Next.js loads:
 *
 * 1. Cloudflare Access (`cloudflare-access.ts`): 503 when production has no Access
 *    configuration, 403 without a valid Access JWT.
 * 2. A request with staging's admin key header (#408, `staging-admin-key.ts`) is judged by the
 *    key alone: it goes on only to `/api/admin/*` on staging, after staging's password, with
 *    the right key; otherwise 401, whatever cookie it carries. The right key on the allowlist's
 *    endpoints (`/api/admin/admins`) is 403.
 * 3. Any other request without a Better Auth session cookie: a GET or HEAD for an `/admin` page
 *    goes to sign-in and back to that page (#488); everything else, `/api/admin` included, is 401.
 *
 * Requests that pass still reach the pages and route handlers, which authorize the session
 * itself with `requireAdmin()` (sign-in and back for an invalid session, 403 for a non-admin),
 * or the key again with `authorizeAdminRequest()`. The gate makes every admin path fail closed
 * even where no route exists, and keeps anonymous traffic away from Next.js and D1.
 */
import { signInPath } from './callback-url'
import { type AccessEnv, type VerifyAccessOptions, verifyAccessRequest } from './cloudflare-access'
import { hasSessionCookie } from './cookies'
import {
  hasStagingAdminKey,
  type StagingAdminKeyEnv,
  stagingAdminKeyDecision
} from './staging-admin-key'

export interface AdminGateEnv extends AccessEnv, StagingAdminKeyEnv {}

const ADMIN_PAGES = '/admin'
const ADMIN_PREFIXES = [ADMIN_PAGES, '/api/admin']

/**
 * The request header that brings an admin page request's own path and query to
 * `requireAdmin()` (`server.ts`), which sends an invalid session there through sign-in. Only the
 * Worker sets it (`withAdminPagePath`), after removing any copy the client sent.
 */
export const ADMIN_PAGE_PATH_HEADER = 'x-admin-page-path'

/** Next.js's marker on a router request's URL, never part of a page's address. */
const ROUTER_MARKER = '_rsc'

/**
 * A path in any letter case, with percent-encoding and repeated slashes resolved the way a
 * router might; null when it cannot be decoded.
 */
function normalizedPath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname)
      .replace(/[\\/]+/gu, '/')
      .toLowerCase()
  } catch {
    return null
  }
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * True for `/admin`, `/api/admin`, and everything below them, in any letter case, with
 * percent-encoding and repeated slashes resolved the way a router might. A path that cannot
 * be decoded is treated as an admin path.
 */
export function isAdminPath(pathname: string): boolean {
  const normalized = normalizedPath(pathname)
  return normalized === null || ADMIN_PREFIXES.some(prefix => isUnder(normalized, prefix))
}

/**
 * Where sign-in returns a GET or HEAD request for an `/admin` page to: its path and query as
 * requested, without Next.js's router marker. Null for `/api/admin`, every other method, a path
 * that cannot be decoded, and every path outside `/admin`.
 */
export function adminPageReturnPath(request: Request): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  const normalized = normalizedPath(url.pathname)
  if (normalized === null || !isUnder(normalized, ADMIN_PAGES)) return null
  if (url.searchParams.has(ROUTER_MARKER)) url.searchParams.delete(ROUTER_MARKER)
  return `${url.pathname}${url.search}`
}

/**
 * The request the Worker hands to Next.js: without a client's `x-admin-page-path`, and with the
 * Worker's own for an `/admin` page (`adminPageReturnPath`). Any other request is unchanged.
 */
export function withAdminPagePath(request: Request): Request {
  const returnPath = adminPageReturnPath(request)
  if (returnPath === null && !request.headers.has(ADMIN_PAGE_PATH_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(ADMIN_PAGE_PATH_HEADER)
  if (returnPath !== null) headers.set(ADMIN_PAGE_PATH_HEADER, returnPath)
  return new Request(request, { headers })
}

const GATE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow'
}

function denied(status: 401 | 403 | 503, message: string): Response {
  return new Response(`${message}\n`, {
    headers: { ...GATE_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    status
  })
}

/** Sign-in, then back to `returnPath`; relative, so the browser stays on its origin. */
function signInRedirect(returnPath: string): Response {
  return new Response(null, {
    headers: { ...GATE_HEADERS, location: signInPath(returnPath) },
    status: 303
  })
}

/**
 * A 401, 403, or 503 (or, for an admin page without a session cookie, a 303 to sign-in) for an
 * admin request that may not proceed, otherwise null. `passedStagingGate` is true only for a
 * request that gave staging's password (#359); the admin key counts on no other.
 */
export async function adminGate(
  request: Request,
  env: AdminGateEnv,
  options: VerifyAccessOptions = {},
  { passedStagingGate = false }: { passedStagingGate?: boolean } = {}
): Promise<Response | null> {
  if (!isAdminPath(new URL(request.url).pathname)) return null
  const access = await verifyAccessRequest(request, env, options)
  if (access.status === 'not-configured') return denied(503, 'Access not configured')
  if (access.status === 'missing' || access.status === 'invalid') return denied(403, 'Forbidden')
  if (hasStagingAdminKey(request)) {
    const decision = passedStagingGate ? await stagingAdminKeyDecision(request, env) : 'refused'
    if (decision === 'admitted') return null
    return decision === 'forbidden' ? denied(403, 'Forbidden') : denied(401, 'Unauthorized')
  }
  if (!hasSessionCookie(request.headers.get('cookie'))) {
    const returnPath = adminPageReturnPath(request)
    return returnPath === null ? denied(401, 'Unauthorized') : signInRedirect(returnPath)
  }
  return null
}
