/**
 * Staging's admin key for agents (serpcompany/best.serp.co#408). An agent can't type a password
 * or an emailed sign-in code into `/login`, so on staging it can act as an admin through the admin
 * API with a key in a request header instead of a session:
 *
 * - **Only `/api/admin/*`.** The key never opens an `/admin` page, and never creates a session or
 *   sets a cookie: it is checked on each request and nothing about it is stored.
 * - **Only staging.** `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` must both be exactly `staging`.
 *   Production, local (a local Worker serving as staging with `LOCAL_STAGING_ACCESS=on`
 *   included), and a missing or misspelled environment refuse every key, even with the secret
 *   set.
 * - **The key** is the Worker secret `STAGING_ADMIN_TOKEN`, at least 32 characters; without it, or
 *   with a shorter one, every key is refused. The header must equal it, compared as SHA-256
 *   digests in constant time (`secretsEqual`, as staging's password is).
 * - **Behind staging's password** (#359). The Worker entry admits a key only on a request that
 *   passed the password (`admin-gate.ts`); the smoke-test exemption doesn't carry it.
 * - **The header decides.** A request that carries it is judged by the key alone: a wrong key is
 *   refused even with a valid session cookie, so an agent's request never acts as a person.
 * - **Identity.** A valid key acts as the fixed actor `staging-agent`, which no email can equal,
 *   recorded on every decision, event, and publication run. The plans' compare-and-swap guards
 *   apply as they do for any admin.
 * - **No `Origin` check** for a valid key: CSRF rides on credentials a browser attaches by itself,
 *   and no browser sends this header unless a script holding the key sets it. Requests with a
 *   session keep the check.
 * - **Never logged or echoed.** Nothing here logs, no answer or error carries the value, and
 *   Sentry never receives request headers (`scrubEvent`). Cloudflare's tail events also redact
 *   the value of any header whose name contains `token`.
 *
 * The Worker entry (`admin-gate.ts`) and `authorizeAdminRequest()` (`server.ts`) both check it.
 * This module has no Next.js or `server-only` imports, so the Worker can run it before OpenNext.
 */
import { secretsEqual } from '../environment/staging-access'
import type { Authorization, SessionUser } from './guards'

/** The request header that carries the key (Fetch headers are case-insensitive). */
export const STAGING_ADMIN_KEY_HEADER = 'x-staging-admin-token'
export const MIN_STAGING_ADMIN_KEY_LENGTH = 32
/** The actor every decision made with the key records. It has no `@`, so no email equals it. */
export const STAGING_ADMIN_ACTOR = 'staging-agent'

/** The Worker vars and secret the key reads. */
export interface StagingAdminKeyEnv {
  D1_RUNTIME_ENV?: string
  SITE_ENVIRONMENT?: string
  /** Worker secret on staging only (`wrangler secret put STAGING_ADMIN_TOKEN --env staging`). */
  STAGING_ADMIN_TOKEN?: string
}

/** True when the request carries the header, with any value (an empty one included). */
export function hasStagingAdminKey(request: Pick<Request, 'headers'>): boolean {
  return request.headers.has(STAGING_ADMIN_KEY_HEADER)
}

/**
 * True for `/api/admin` and everything below it, in any letter case, with percent-encoding and
 * repeated slashes resolved, as `isAdminPath` (`admin-gate.ts`) reads admin paths. A path that
 * cannot be decoded is not one, so the key is refused there.
 */
export function isAdminApiPath(pathname: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }
  const normalized = decoded.replace(/[\\/]+/gu, '/').toLowerCase()
  return normalized === '/api/admin' || normalized.startsWith('/api/admin/')
}

/** The key this Worker accepts: only on staging, and only a secret of at least 32 characters. */
function configuredKey(env: StagingAdminKeyEnv): string | null {
  if (env.SITE_ENVIRONMENT !== 'staging' || env.D1_RUNTIME_ENV !== 'staging') return null
  const key = env.STAGING_ADMIN_TOKEN?.trim() ?? ''
  return key.length >= MIN_STAGING_ADMIN_KEY_LENGTH ? key : null
}

/**
 * True only when the request may act as `staging-agent`: an `/api/admin/*` path on a staging
 * Worker whose secret is set, and a header equal to it. Everything else is false.
 */
export async function stagingAdminKeyMatches(
  request: Request,
  env: StagingAdminKeyEnv
): Promise<boolean> {
  const expected = configuredKey(env)
  if (!expected || !isAdminApiPath(new URL(request.url).pathname)) return false
  const given = request.headers.get(STAGING_ADMIN_KEY_HEADER)
  if (given === null) return false
  return secretsEqual(given, expected)
}

/** The admin a valid key acts as: no session, no account, the fixed actor. */
function stagingAgent(): SessionUser {
  return {
    email: STAGING_ADMIN_ACTOR,
    emailVerified: true,
    id: STAGING_ADMIN_ACTOR,
    name: 'Staging agent',
    role: 'admin'
  }
}

/**
 * The admin decision for a request that carries the key: `staging-agent` when it matches,
 * otherwise 401 `admin_key_rejected`. The `Origin` check doesn't apply (see the module comment).
 */
export async function authorizeStagingAdminKey(
  request: Request,
  env: StagingAdminKeyEnv
): Promise<Authorization> {
  if (await stagingAdminKeyMatches(request, env)) {
    return { ok: true, sessionId: null, user: stagingAgent() }
  }
  return { ok: false, reason: 'admin_key_rejected', status: 401 }
}
