/**
 * Authorization decisions behind `requireUser()` and `requireAdmin()` (serpcompany/best.serp.co#60).
 * They are pure: the session and the admin status are injected, so every outcome is unit-tested
 * (`guards.test.ts`) and `server.ts` only adapts them to Next.js.
 *
 * Every failure is closed: a missing session is 401, a signed-in user who is not an admin is
 * 403, and accounts that cannot be checked (auth misconfigured, D1 unavailable) are 503.
 * An admin is a signed-in user whose verified email is on the D1 allowlist *now* and whose
 * role, set from the allowlist at sign-in, is `admin`; removing an email from the allowlist
 * revokes admin access on the next request.
 */
import type { AdminStatus } from '@serpdirectory/data-ops/auth'

export interface SessionUser {
  email: string
  emailVerified: boolean
  id: string
  name: string
  role?: string | null
}

export interface SessionSnapshot {
  session: { expiresAt: Date | string; id: string }
  user: SessionUser
}

export type AuthorizationFailure = {
  ok: false
  reason: 'admin_required' | 'auth_unavailable' | 'origin_rejected' | 'session_required'
  status: 401 | 403 | 503
}

export type Authorization =
  | { ok: true; sessionId: string; user: SessionUser }
  | AuthorizationFailure

export interface UserGuardDependencies {
  /** The current session, or null when the request carries none. */
  getSession(): Promise<SessionSnapshot | null>
  now?: () => Date
}

export interface AdminGuardDependencies extends UserGuardDependencies {
  getAdminStatus(userId: string): Promise<AdminStatus | null>
}

const unavailable: AuthorizationFailure = { ok: false, reason: 'auth_unavailable', status: 503 }
const sessionRequired: AuthorizationFailure = {
  ok: false,
  reason: 'session_required',
  status: 401
}
const adminRequired: AuthorizationFailure = { ok: false, reason: 'admin_required', status: 403 }
const originRejected: AuthorizationFailure = { ok: false, reason: 'origin_rejected', status: 403 }

/** Methods that cannot change state; every other admin request must come from a trusted origin. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Same-site is not enough for admin writes: every `*.serp.co` site is same-site with
 * best.serp.co, and `SameSite=Lax` lets such a sibling send POSTs with the session cookie. A
 * state-changing admin request therefore needs an `Origin` that is one of this Worker's
 * trusted origins (`isTrustedOrigin` in `settings.ts`).
 */
export function checkAdminRequestOrigin(
  request: Pick<Request, 'headers' | 'method'>,
  isTrusted: (origin: string | null) => boolean
): AuthorizationFailure | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null
  return isTrusted(request.headers.get('origin')) ? null : originRejected
}

function log(reason: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'auth_guard_error',
      message: error instanceof Error ? error.message : String(error),
      reason
    })
  )
}

export async function authorizeUser({
  getSession,
  now = () => new Date()
}: UserGuardDependencies): Promise<Authorization> {
  let snapshot: SessionSnapshot | null
  try {
    snapshot = await getSession()
  } catch (error) {
    log('session', error)
    return unavailable
  }
  if (!snapshot?.user?.id || !snapshot.session?.id) return sessionRequired
  const expiresAt = new Date(snapshot.session.expiresAt).getTime()
  if (!Number.isFinite(expiresAt) || expiresAt <= now().getTime()) return sessionRequired
  if (!snapshot.user.emailVerified) return sessionRequired
  return { ok: true, sessionId: snapshot.session.id, user: snapshot.user }
}

export async function authorizeAdmin(dependencies: AdminGuardDependencies): Promise<Authorization> {
  const user = await authorizeUser(dependencies)
  if (!user.ok) return user
  let status: AdminStatus | null
  try {
    status = await dependencies.getAdminStatus(user.user.id)
  } catch (error) {
    log('admin_status', error)
    return unavailable
  }
  if (
    !status ||
    !status.allowlisted ||
    !status.emailVerified ||
    status.role !== 'admin' ||
    status.email !== user.user.email.trim().toLowerCase()
  ) {
    return adminRequired
  }
  return user
}

/** A JSON error response for a failed authorization (route handlers). */
export function authorizationErrorResponse(failure: AuthorizationFailure): Response {
  const message = {
    admin_required: 'Admin access required.',
    auth_unavailable: 'Accounts are unavailable.',
    origin_rejected: 'This request must come from this site.',
    session_required: 'Sign in required.'
  }[failure.reason]
  return Response.json(
    { error: failure.reason, message },
    {
      headers: { 'cache-control': 'private, no-store' },
      status: failure.status
    }
  )
}
