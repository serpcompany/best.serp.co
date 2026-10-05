import 'server-only'

/**
 * Server-only account adapter (serpcompany/best.serp.co#60): acquires and validates the `DB`
 * binding and the Better Auth settings from the OpenNext Cloudflare context, builds the auth
 * instance (`config.ts`), and exposes the guards to pages and route handlers.
 *
 * - `requireUser()` / `requireAdmin()` for Server Components and route handlers: they return
 *   the signed-in user or interrupt with Next.js `unauthorized()` (401) / `forbidden()` (403).
 * - `authorizeAdminRequest()` returns the decision, for route handlers that answer JSON.
 *
 * Accounts that cannot be checked (missing binding, invalid settings) fail closed: the auth
 * route answers 503 and the guards never grant access.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createAuthOperations } from '@serpdirectory/data-ops/auth'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { headers } from 'next/headers'
import { forbidden, unauthorized } from 'next/navigation'
import { cache } from 'react'
import { type Auth, createAuth } from './config'
import {
  type Authorization,
  authorizeAdmin,
  authorizeUser,
  checkAdminRequestOrigin,
  type SessionSnapshot,
  type SessionUser
} from './guards'
import { deriveKey, RATE_LIMIT_KEY_LABEL } from './keys'
import { selectOtpSender } from './otp-sender'
import {
  AuthConfigurationError,
  type AuthEnv,
  type AuthSettings,
  isTrustedOrigin,
  resolveAuthSettings
} from './settings'

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

interface AccountRuntime {
  auth: Auth
  operations: ReturnType<typeof createAuthOperations>
  settings: AuthSettings
}

const runtimes = new WeakMap<D1Database, { key: string; runtime: AccountRuntime }>()

function runtimeKey(settings: ReturnType<typeof resolveAuthSettings>): string {
  return JSON.stringify([
    settings.environment,
    settings.baseURL,
    settings.trustedOrigins,
    settings.secret
  ])
}

function assertAccountBinding(env: CloudflareEnv): D1Database {
  if (!env.DB) throw new AuthConfigurationError('D1 binding DB is required; accounts fail closed.')
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV)) {
    throw new AuthConfigurationError(
      `Invalid D1 runtime environment: ${env.D1_RUNTIME_ENV || 'missing'}.`
    )
  }
  return env.DB
}

/** The auth instance for this Worker's binding and settings (reused across requests). */
export async function getAccountRuntime(): Promise<AccountRuntime> {
  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as CloudflareEnv
  const binding = assertAccountBinding(cloudflareEnv)
  const settings = resolveAuthSettings(cloudflareEnv as AuthEnv)
  const key = runtimeKey(settings)
  const cached = runtimes.get(binding)
  if (cached && cached.key === key) return cached.runtime
  const client = createDatabase(binding)
  const operations = createAuthOperations({
    client,
    rateLimitKey: await deriveKey(settings.secret, RATE_LIMIT_KEY_LABEL)
  })
  const runtime = {
    auth: createAuth({
      client,
      operations,
      sender: selectOtpSender(settings.environment),
      settings
    }),
    operations,
    settings
  }
  runtimes.set(binding, { key, runtime })
  return runtime
}

/** The `/api/auth/*` handler; misconfigured accounts answer 503. */
export async function handleAuthRequest(request: Request): Promise<Response> {
  let runtime: AccountRuntime
  try {
    runtime = await getAccountRuntime()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'auth_unavailable',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return Response.json(
      { error: 'auth_unavailable', message: 'Accounts are unavailable.' },
      { headers: { 'cache-control': 'private, no-store' }, status: 503 }
    )
  }
  const response = await runtime.auth.handler(request)
  if (!response.headers.has('cache-control')) {
    const withHeaders = new Response(response.body, response)
    withHeaders.headers.set('cache-control', 'private, no-store')
    return withHeaders
  }
  return response
}

async function readSession(requestHeaders: Headers): Promise<SessionSnapshot | null> {
  const { auth } = await getAccountRuntime()
  const result = await auth.api.getSession({ headers: requestHeaders })
  if (!result) return null
  return {
    session: { expiresAt: result.session.expiresAt, id: result.session.id },
    user: {
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      id: result.user.id,
      name: result.user.name,
      role: (result.user as { role?: string | null }).role ?? null
    }
  }
}

const authorizeCurrentUser = cache(
  async (): Promise<Authorization> =>
    authorizeUser({ getSession: async () => readSession(await headers()) })
)

const authorizeCurrentAdmin = cache(
  async (): Promise<Authorization> =>
    authorizeAdmin({
      getAdminStatus: async userId => (await getAccountRuntime()).operations.getAdminStatus(userId),
      getSession: async () => readSession(await headers())
    })
)

/** The session user of the current request, or null (never throws for signed-out visitors). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const result = await authorizeCurrentUser()
  return result.ok ? result.user : null
}

function interrupt(result: Authorization): SessionUser {
  if (result.ok) return result.user
  if (result.status === 401) unauthorized()
  if (result.status === 403) forbidden()
  throw new AuthConfigurationError('Accounts are unavailable.')
}

/** The signed-in user; otherwise 401 (Next.js `unauthorized()`). */
export async function requireUser(): Promise<SessionUser> {
  return interrupt(await authorizeCurrentUser())
}

/** A signed-in admin; otherwise 401 or 403 (Next.js `unauthorized()` / `forbidden()`). */
export async function requireAdmin(): Promise<SessionUser> {
  return interrupt(await authorizeCurrentAdmin())
}

/** The admin decision for a route handler that answers its own JSON errors. */
/**
 * The admin decision for a route handler that answers its own JSON errors. A request that can
 * change state (anything but GET, HEAD, OPTIONS) must also carry a trusted `Origin`.
 */
export async function authorizeAdminRequest(request: Request): Promise<Authorization> {
  let runtime: AccountRuntime
  try {
    runtime = await getAccountRuntime()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'auth_unavailable',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return { ok: false, reason: 'auth_unavailable', status: 503 }
  }
  const origin = checkAdminRequestOrigin(request, value =>
    isTrustedOrigin(value, runtime.settings.trustedOrigins)
  )
  if (origin) return origin
  return authorizeAdmin({
    getAdminStatus: userId => runtime.operations.getAdminStatus(userId),
    getSession: async () => readSession(request.headers)
  })
}
