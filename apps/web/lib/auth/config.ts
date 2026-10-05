/**
 * The Better Auth server (serpcompany/best.serp.co#59, #60): email OTP sign-in for everyone,
 * on the injected D1 client, with roles from the D1 admin allowlist.
 *
 * - Sign-in is a six-digit code sent by email (`otp-sender.ts`); a first sign-in creates the
 *   account. Only the endpoints in `ALLOWED_AUTH_ENDPOINTS` are served over HTTP: every other
 *   Better Auth endpoint (passwords, social, account linking, profile updates, deletion, and
 *   anything a Better Auth upgrade adds) answers 404 before Better Auth sees the request.
 * - Codes are stored hashed, expire after ten minutes, and allow three guesses, only from the
 *   browser that requested the email's latest code (`code-binding.ts`). Code requests and
 *   guesses are limited in D1 (`rate-limits.ts`); a code request denied by a per-email limit
 *   answers like a sent one, so responses never reveal whether an email has an account.
 *   Better Auth's own limiter is off: its default store is per-isolate memory.
 * - Each new session sets the user's role from the allowlist (`syncUserRole`); `guards.ts`
 *   also checks the allowlist live on every admin request.
 *
 * This module builds an instance per Worker binding and has no Next.js or `server-only`
 * imports, so tests run the real configuration against SQLite (`config.test.ts`).
 */

import {
  type AuthOperations,
  authSchemaOptions,
  createAuthDatabaseAdapter,
  normalizeEmail
} from '@serpdirectory/data-ops/auth'
import type { Database } from '@serpdirectory/data-ops/client'
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'
import { emailOTP } from 'better-auth/plugins/email-otp'
import type { BetterAuthPlugin } from 'better-auth/types'
import {
  type BoundCode,
  clearCodeBindingSetCookie,
  codeBindingCookieName,
  codeBindingCookieOptions,
  decoyCodeBinding,
  findCodeBinding,
  hashOtp,
  issueCodeBinding,
  readCodeBindingTokens
} from './code-binding'
import { AUTH_COOKIE_PREFIX } from './cookies'
import { CODE_BINDING_KEY_LABEL, deriveKey, KNOWN_DEVICE_KEY_LABEL } from './keys'
import {
  anyKnownDevice,
  issueKnownDevice,
  knownDeviceSetCookie,
  readKnownDeviceTokens
} from './known-device'
import {
  OtpDeliveryUnavailableError,
  type OtpSender,
  otpDeliveryReady,
  readDevOtpOutbox
} from './otp-sender'
import {
  clientIp,
  type EmailStanding,
  OTP_ALLOWED_ATTEMPTS,
  OTP_EXPIRES_IN_SECONDS,
  OTP_LENGTH,
  otpClientRules,
  otpEmailRules,
  signInAttemptRules
} from './rate-limits'
import type { AuthSettings } from './settings'

export const AUTH_BASE_PATH = '/api/auth'
export const SEND_OTP_PATH = '/email-otp/send-verification-otp'
export const SIGN_IN_OTP_PATH = '/sign-in/email-otp'
export const GET_SESSION_PATH = '/get-session'
export const SIGN_OUT_PATH = '/sign-out'
export const DEV_OTP_OUTBOX_PATH = '/dev/otp-outbox'

/** Longest display name a first sign-in may set; the UI escapes it like any text. */
export const MAX_NAME_LENGTH = 80

export interface AuthEndpoint {
  method: 'GET' | 'POST'
  path: string
}

/** The only Better Auth endpoints served over HTTP. */
export const ALLOWED_AUTH_ENDPOINTS: readonly AuthEndpoint[] = [
  { method: 'POST', path: SEND_OTP_PATH },
  { method: 'POST', path: SIGN_IN_OTP_PATH },
  { method: 'GET', path: GET_SESSION_PATH },
  { method: 'POST', path: SIGN_OUT_PATH }
]

/** Served only while the local dev sender runs. */
export const DEV_AUTH_ENDPOINTS: readonly AuthEndpoint[] = [
  { method: 'GET', path: DEV_OTP_OUTBOX_PATH }
]

export interface CreateAuthOptions {
  client: Database
  operations: AuthOperations
  sender: OtpSender
  settings: AuthSettings
}

/** What the application uses of a Better Auth instance. */
export interface Auth {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      session: { expiresAt: Date; id: string; userId: string }
      user: { email: string; emailVerified: boolean; id: string; name: string; role?: unknown }
    } | null>
  }
  /** Serves an `/api/auth/*` request; anything outside the allowlist is 404. */
  handler(request: Request): Promise<Response>
  /** Every HTTP endpoint Better Auth registered (for the allowlist tests). */
  readonly routes: readonly { methods: readonly string[]; path: string }[]
}

/** Local only: returns the latest code the dev sender delivered, for HTTP tests. */
function devOtpOutboxPlugin() {
  return {
    id: 'dev-otp-outbox',
    endpoints: {
      devOtpOutbox: createAuthEndpoint(DEV_OTP_OUTBOX_PATH, { method: 'GET' }, async ctx => {
        const email = typeof ctx.query?.email === 'string' ? ctx.query.email : ''
        const entry = email ? readDevOtpOutbox(email) : null
        return ctx.json({ otp: entry?.otp ?? null, sentAt: entry?.sentAt ?? null })
      })
    }
  } satisfies BetterAuthPlugin
}

function rateLimited(retryAfterSeconds: number): APIError {
  return new APIError(
    'TOO_MANY_REQUESTS',
    { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    { 'Retry-After': String(retryAfterSeconds), 'X-Retry-After': String(retryAfterSeconds) }
  )
}

function badRequest(code: string, message: string): APIError {
  return new APIError('BAD_REQUEST', { code, message })
}

function notFound(): Response {
  return Response.json(
    { error: 'not_found', message: 'No such auth endpoint.' },
    { headers: { 'cache-control': 'private, no-store' }, status: 404 }
  )
}

interface RoutableEndpoint {
  options?: { method?: string | string[] }
  path?: string
}

/** What the hooks read of Better Auth's database adapter. */
interface VerificationReader {
  findMany<T>(query: {
    limit?: number
    model: string
    sortBy?: { direction: 'asc' | 'desc'; field: string }
    where?: { field: string; value: string }[]
  }): Promise<T[]>
}

/**
 * The stored hash of the latest sign-in code for `email` (Better Auth's lowercased address),
 * read without Better Auth's `findVerificationValue`, which also deletes every expired code
 * and would turn the next "expired" answer into "invalid".
 */
async function latestStoredOtp(adapter: VerificationReader, email: string): Promise<string | null> {
  const [row] = await adapter.findMany<{ value: string }>({
    limit: 1,
    model: 'verification',
    sortBy: { direction: 'desc', field: 'createdAt' },
    where: [{ field: 'identifier', value: `sign-in-otp-${email}` }]
  })
  if (!row) return null
  // Better Auth stores `<hash>:<attempts>`.
  const separator = row.value.lastIndexOf(':')
  return separator === -1 ? row.value : row.value.slice(0, separator)
}

export function createAuth({ client, operations, sender, settings }: CreateAuthOptions): Auth {
  if (sender.kind === 'dev-console' && settings.environment !== 'local') {
    throw new Error('The dev sign-in code sender only runs locally.')
  }
  const devSender = sender.kind === 'dev-console'
  const secure = settings.useSecureCookies
  const knownDeviceKey = deriveKey(settings.secret, KNOWN_DEVICE_KEY_LABEL)
  knownDeviceKey.catch(() => undefined)
  const codeBindingKey = deriveKey(settings.secret, CODE_BINDING_KEY_LABEL)
  codeBindingKey.catch(() => undefined)

  /** Which code limits apply: see `rate-limits.ts`. */
  async function emailStanding(
    email: string,
    cookieHeader: string | null | undefined
  ): Promise<EmailStanding> {
    const account = await operations.findVerifiedAccount(email)
    if (!account) return 'new'
    const tokens = readKnownDeviceTokens(cookieHeader, secure)
    const known = await anyKnownDevice(await knownDeviceKey, tokens, account.id, new Date())
    return known ? 'known-device' : 'member'
  }

  /** The binding cookie's value for a code this request created. */
  async function bindingFor(code: BoundCode): Promise<string> {
    return issueCodeBinding(await codeBindingKey, code, new Date())
  }

  /**
   * The binding a code request that sends nothing answers with: a fresh binding for the
   * email's current code when the browser already holds one (so the code it has keeps
   * working), else a decoy. Either way the response matches one that sent a code.
   */
  async function unsentBinding(
    adapter: VerificationReader,
    email: string,
    cookieHeader: string | null | undefined
  ): Promise<string> {
    const now = new Date()
    const tokens = readCodeBindingTokens(cookieHeader, secure)
    const storedOtp = tokens.length > 0 ? await latestStoredOtp(adapter, email) : null
    if (storedOtp !== null) {
      const code = { email, storedOtp }
      if (await findCodeBinding(await codeBindingKey, tokens, code, now)) return bindingFor(code)
    }
    return decoyCodeBinding(now)
  }

  /** True when the request holds a binding for the email's latest code. */
  async function holdsCodeBinding(
    adapter: VerificationReader,
    email: string,
    cookieHeader: string | null | undefined
  ): Promise<boolean> {
    const tokens = readCodeBindingTokens(cookieHeader, secure)
    if (tokens.length === 0) return false
    const storedOtp = await latestStoredOtp(adapter, email)
    if (storedOtp === null) return false
    const code = { email, storedOtp }
    return (await findCodeBinding(await codeBindingKey, tokens, code, new Date())) !== null
  }

  /** Adds the known-device cookie to a successful sign-in response. */
  async function rememberDevice(response: Response): Promise<Response> {
    if (response.status !== 200) return response
    let userId: unknown
    try {
      userId = ((await response.clone().json()) as { user?: { id?: unknown } }).user?.id
    } catch {
      return response
    }
    if (typeof userId !== 'string' || !userId) return response
    const token = await issueKnownDevice(await knownDeviceKey, userId, new Date())
    const remembered = new Response(response.body, response)
    remembered.headers.append('set-cookie', knownDeviceSetCookie(token, secure))
    // The code is used up, so its binding is too.
    remembered.headers.append('set-cookie', clearCodeBindingSetCookie(secure))
    return remembered
  }
  const allowed = [...ALLOWED_AUTH_ENDPOINTS, ...(devSender ? DEV_AUTH_ENDPOINTS : [])]
  const otpPlugin = emailOTP({
    allowedAttempts: OTP_ALLOWED_ATTEMPTS,
    expiresIn: OTP_EXPIRES_IN_SECONDS,
    otpLength: OTP_LENGTH,
    // Better Auth's `hashed` digest, computed here so the binding can name the stored hash.
    storeOTP: { hash: hashOtp },
    // Awaited by Better Auth, which logs and swallows a failure so the response never
    // reveals whether an email was sent. `email` is Better Auth's lowercased address.
    async sendVerificationOTP({ email, otp, type }, ctx) {
      // Bind the code to this browser before delivery, so a failed delivery answers the same.
      ctx?.setCookie(
        codeBindingCookieName(secure),
        await bindingFor({ email, storedOtp: await hashOtp(otp) }),
        codeBindingCookieOptions(secure)
      )
      await sender.send({ email, expiresInSeconds: OTP_EXPIRES_IN_SECONDS, otp, purpose: type })
    }
  })
  /** Exactly Better Auth's answer to a wrong code. */
  const invalidCode = () => APIError.from('BAD_REQUEST', otpPlugin.$ERROR_CODES.INVALID_OTP)
  const plugins = [otpPlugin, ...(devSender ? [devOtpOutboxPlugin()] : [])]

  const instance = betterAuth({
    ...authSchemaOptions,
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      // Explicit, so the origin and CSRF checks never depend on NODE_ENV (Better Auth skips
      // them by default under test).
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      useSecureCookies: settings.useSecureCookies
    },
    appName: 'best.serp.co',
    basePath: AUTH_BASE_PATH,
    baseURL: settings.baseURL,
    database: createAuthDatabaseAdapter(client),
    databaseHooks: {
      session: {
        create: {
          async after(session) {
            await operations.syncUserRole(session.userId)
          }
        }
      }
    },
    emailAndPassword: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async ctx => {
        if (ctx.path === SEND_OTP_PATH) {
          // Better Auth swallows delivery errors (the endpoint still answers success), so an
          // environment without a sender, or whose email is not configured (a missing useSend
          // key, a bad base URL, no DB), refuses before a code exists.
          if (!(await otpDeliveryReady(sender))) {
            throw new APIError('SERVICE_UNAVAILABLE', {
              code: 'OTP_DELIVERY_UNAVAILABLE',
              message: new OtpDeliveryUnavailableError().message
            })
          }
          const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown }
          if (body.type !== 'sign-in') {
            throw badRequest('UNSUPPORTED_OTP_TYPE', 'Only sign-in codes are supported.')
          }
          if (typeof body.email !== 'string' || body.email.trim() === '') return
          const headers = ctx.request?.headers
          const cookieHeader = headers?.get('cookie')
          const ip = clientIp(headers)
          // Per-client limits do not depend on the email, so their 429 reveals nothing.
          const client = await operations.consumeRateLimit(otpClientRules(ip))
          if (!client.allowed) throw rateLimited(client.retryAfterSeconds)
          const email = normalizeEmail(body.email)
          const standing = await emailStanding(email, cookieHeader)
          const decision = await operations.consumeRateLimit(otpEmailRules({ email, ip, standing }))
          if (decision.allowed) return
          // A per-email limit: answer exactly like a sent code, and send nothing.
          ctx.setCookie(
            codeBindingCookieName(secure),
            await unsentBinding(ctx.context.adapter, body.email.toLowerCase(), cookieHeader),
            codeBindingCookieOptions(secure)
          )
          return ctx.json({ success: true })
        }
        if (ctx.path === SIGN_IN_OTP_PATH) {
          const body = (ctx.body ?? {}) as { image?: unknown; name?: unknown }
          // A first sign-in may name the account, but never set an image URL (nothing renders
          // one yet, and a `javascript:` URL would wait for the first screen that does).
          if (body.image !== undefined) {
            throw badRequest('FIELD_NOT_ALLOWED', 'image cannot be set at sign-in.')
          }
          if (
            body.name !== undefined &&
            (typeof body.name !== 'string' || body.name.length > MAX_NAME_LENGTH)
          ) {
            throw badRequest('INVALID_NAME', `name must be text of at most ${MAX_NAME_LENGTH}.`)
          }
          const headers = ctx.request?.headers
          const decision = await operations.consumeRateLimit(signInAttemptRules(clientIp(headers)))
          if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds)
          // Only the browser that requested the email's latest code may guess it, so other
          // clients cannot use up its three attempts. Refused before Better Auth counts the
          // guess, with the same answer as a wrong code.
          const email = (ctx.body as { email?: unknown } | undefined)?.email
          if (typeof email !== 'string') return
          const cookieHeader = headers?.get('cookie')
          if (!(await holdsCodeBinding(ctx.context.adapter, email.toLowerCase(), cookieHeader))) {
            throw invalidCode()
          }
        }
      })
    },
    plugins,
    rateLimit: { enabled: false },
    secret: settings.secret,
    telemetry: { enabled: false },
    trustedOrigins: settings.trustedOrigins
  })

  const routes = Object.values(instance.api as Record<string, RoutableEndpoint>)
    .filter((endpoint): endpoint is RoutableEndpoint & { path: string } => Boolean(endpoint?.path))
    .map(endpoint => ({
      methods: [endpoint.options?.method ?? 'GET'].flat().map(method => method.toUpperCase()),
      path: endpoint.path
    }))

  return {
    api: instance.api,
    async handler(request) {
      const { pathname } = new URL(request.url)
      const path = pathname.startsWith(`${AUTH_BASE_PATH}/`)
        ? pathname.slice(AUTH_BASE_PATH.length)
        : null
      const served = allowed.some(
        endpoint => endpoint.method === request.method && endpoint.path === path
      )
      if (!served) return notFound()
      const response = await instance.handler(request)
      return path === SIGN_IN_OTP_PATH ? rememberDevice(response) : response
    },
    routes
  }
}
