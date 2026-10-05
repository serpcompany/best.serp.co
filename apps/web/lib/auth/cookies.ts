/**
 * Better Auth cookie names (serpcompany/best.serp.co#60). Better Auth names its cookies
 * `<prefix>.<name>` (`better-auth.session_token`) and adds `__Secure-` on https origins.
 *
 * The edge HTML cache (`lib/edge-cache/html-cache.ts`) bypasses every request that carries
 * one of these cookies, and the Worker's admin gate (`lib/auth/admin-gate.ts`) answers 401
 * when no session cookie is present. Both run before Next.js loads, so this module has no
 * imports; `lib/auth/config.ts` configures Better Auth with the same prefix.
 */

export const AUTH_COOKIE_PREFIX = 'better-auth'
export const SESSION_COOKIE_NAME = 'session_token'

/** Any Better Auth cookie (session token, session data, dont-remember, ...). */
export const AUTH_COOKIE_PATTERN = /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth[.-][\w.-]+=/u

/** The session token cookie, which every signed-in request carries. */
const SESSION_COOKIE_PATTERN =
  /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth[.-]session_token=[^;\s]/u

export function hasAuthCookie(cookieHeader: string | null | undefined): boolean {
  return Boolean(cookieHeader && AUTH_COOKIE_PATTERN.test(cookieHeader))
}

export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return Boolean(cookieHeader && SESSION_COOKIE_PATTERN.test(cookieHeader))
}
