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

/**
 * Every non-empty value of the cookie `name` in a `Cookie` header, in header order. A browser
 * sends one cookie per name, path, and domain, so a sibling `*.serp.co` site can add a
 * same-named cookie for a parent domain or a longer path; callers check each value rather than
 * trusting the first (review round 3, finding 5).
 */
export function readCookieValues(cookieHeader: string | null | undefined, name: string): string[] {
  const values: string[] = []
  for (const part of (cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    if (value) values.push(value)
  }
  return values
}
