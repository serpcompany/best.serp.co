/**
 * Better Auth settings per environment, parsed from the Worker's vars and secrets
 * (serpcompany/best.serp.co#60). Staging and production fail closed: a missing or malformed
 * secret, base URL, or trusted origin is an `AuthConfigurationError`, which the route handler
 * answers with 503 and the guards treat as "not signed in". Only local development may run
 * without `BETTER_AUTH_SECRET` (see docs/DEVELOPMENT.md).
 *
 * | Var | local | staging | production |
 * | --- | --- | --- | --- |
 * | `BETTER_AUTH_SECRET` (secret) | `apps/web/.dev.vars`, else an ephemeral per-isolate value | Worker secret | Worker secret |
 * | `BETTER_AUTH_URL` | unset: the request's localhost origin | `https://staging.best.serp.co` | `https://best.serp.co` |
 * | `BETTER_AUTH_TRUSTED_ORIGINS` | unset: localhost origins | the same origin | the same origin |
 */
import { parseSiteEnvironment, type SiteEnvironment } from '../environment/site-environment'

export const MIN_SECRET_LENGTH = 32

/** The localhost hosts and origins Better Auth accepts locally (any port). */
export const LOCAL_ALLOWED_HOSTS = ['localhost', 'localhost:*', '127.0.0.1', '127.0.0.1:*']
export const LOCAL_TRUSTED_ORIGINS = [
  'http://localhost',
  'http://localhost:*',
  'http://127.0.0.1',
  'http://127.0.0.1:*'
]

export interface AuthEnv {
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_TRUSTED_ORIGINS?: string
  BETTER_AUTH_URL?: string
  D1_RUNTIME_ENV?: string
  SITE_ENVIRONMENT?: string
}

export type AuthBaseUrl = string | { allowedHosts: string[]; protocol: 'http' }

export interface AuthSettings {
  baseURL: AuthBaseUrl
  environment: SiteEnvironment
  secret: string
  /** `ephemeral` only locally without `.dev.vars`: sessions end when the isolate restarts. */
  secretSource: 'configured' | 'ephemeral'
  trustedOrigins: string[]
  /** `__Secure-` cookies on every https environment. */
  useSecureCookies: boolean
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigurationError'
  }
}

export function isAuthConfigurationError(error: unknown): error is AuthConfigurationError {
  return error instanceof Error && error.name === 'AuthConfigurationError'
}

const EPHEMERAL_SECRET_KEY = Symbol.for('best.serp.co/ephemeral-auth-secret')

/**
 * One random secret per isolate, kept on `globalThis`: the bundler can copy this module into
 * several route chunks, and every copy must sign and verify sessions with the same secret.
 */
function localSecret(): string {
  const scope = globalThis as typeof globalThis & { [EPHEMERAL_SECRET_KEY]?: string }
  let secret = scope[EPHEMERAL_SECRET_KEY]
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    secret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    scope[EPHEMERAL_SECRET_KEY] = secret
    console.warn(
      JSON.stringify({
        event: 'auth_ephemeral_secret',
        message:
          'BETTER_AUTH_SECRET is not set; using an ephemeral local secret. Add it to apps/web/.dev.vars to keep sessions across restarts.'
      })
    )
  }
  return secret
}

/** An https origin with nothing after it, or null. */
export function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.origin !== value.replace(/\/$/u, '')) return null
    if (url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

export function resolveAuthSettings(env: AuthEnv): AuthSettings {
  const environment = parseSiteEnvironment(env.SITE_ENVIRONMENT)
  if (!environment || env.D1_RUNTIME_ENV !== environment) {
    throw new AuthConfigurationError(
      'Accounts need SITE_ENVIRONMENT and D1_RUNTIME_ENV set to the same local, staging, or production value.'
    )
  }

  const configuredSecret = env.BETTER_AUTH_SECRET ?? ''
  let secret: string
  let secretSource: AuthSettings['secretSource'] = 'configured'
  if (configuredSecret.length >= MIN_SECRET_LENGTH) {
    secret = configuredSecret
  } else if (environment === 'local' && configuredSecret.length === 0) {
    secret = localSecret()
    secretSource = 'ephemeral'
  } else {
    throw new AuthConfigurationError(
      `BETTER_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters.`
    )
  }

  if (environment === 'local' && !env.BETTER_AUTH_URL) {
    return {
      baseURL: { allowedHosts: LOCAL_ALLOWED_HOSTS, protocol: 'http' },
      environment,
      secret,
      secretSource,
      trustedOrigins: LOCAL_TRUSTED_ORIGINS,
      useSecureCookies: false
    }
  }

  const baseURL = env.BETTER_AUTH_URL ?? ''
  const baseOrigin =
    environment === 'local' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(baseURL)
      ? baseURL
      : httpsOrigin(baseURL)
  if (!baseOrigin) {
    throw new AuthConfigurationError('BETTER_AUTH_URL must be the https origin of this Worker.')
  }
  const extraOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
  const trustedOrigins = [baseOrigin]
  for (const origin of extraOrigins) {
    const parsed = httpsOrigin(origin)
    if (!parsed) {
      throw new AuthConfigurationError(
        `BETTER_AUTH_TRUSTED_ORIGINS has an entry that is not an https origin: ${origin}`
      )
    }
    if (!trustedOrigins.includes(parsed)) trustedOrigins.push(parsed)
  }
  return {
    baseURL: baseOrigin,
    environment,
    secret,
    secretSource,
    trustedOrigins,
    useSecureCookies: baseOrigin.startsWith('https://')
  }
}

/**
 * Whether an `Origin` header names one of the trusted origins: an exact match, or for the
 * local `http://localhost:*` / `http://127.0.0.1:*` patterns, that host on any port.
 */
export function isTrustedOrigin(origin: string | null, trustedOrigins: readonly string[]): boolean {
  if (!origin || origin === 'null') return false
  return trustedOrigins.some(trusted => {
    if (!trusted.endsWith(':*')) return origin === trusted
    const prefix = trusted.slice(0, -1)
    return origin.startsWith(prefix) && /^\d{1,5}$/u.test(origin.slice(prefix.length))
  })
}
