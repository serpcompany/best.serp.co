/**
 * Cloudflare Access, the second lock on `/admin` and `/api/admin` (serpcompany/best.serp.co#59).
 * Access sits in front of those paths on best.serp.co and adds a signed
 * `Cf-Access-Jwt-Assertion` header; the Worker verifies that JWT before any admin request
 * reaches Next.js (`admin-gate.ts`), so admin routes need both Access and an admin session.
 *
 * - Production always requires Access. An unset or malformed team domain or AUD tag fails
 *   closed with 503 "Access not configured".
 * - Local and staging require it only with `CF_ACCESS_REQUIRED=on` (docs/development.md).
 * - A missing, unparseable, wrongly signed, expired, or foreign token is 403.
 *
 * The token must be RS256, signed by a key from `https://<team>/cdn-cgi/access/certs`, issued
 * by `https://<team>`, and carry the application's AUD tag. Keys are cached per isolate.
 * This module has no Next.js imports: it runs in the Worker entry before OpenNext loads.
 */
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import { parseSiteEnvironment } from '../environment/site-environment'

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'
const TEAM_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u
const AUD_PATTERN = /^[a-f0-9]{64}$/u

export interface AccessEnv {
  /** The application's Audience (AUD) tag, a 64-character hex string. */
  CF_ACCESS_AUD?: string
  /** `on` requires Access locally or on staging; production always requires it. */
  CF_ACCESS_REQUIRED?: string
  /** The Zero Trust team domain, for example `serpcompany.cloudflareaccess.com`. */
  CF_ACCESS_TEAM_DOMAIN?: string
  SITE_ENVIRONMENT?: string
}

export interface AccessConfig {
  audience: string
  certsUrl: string
  issuer: string
}

export type AccessDecision =
  | { status: 'not-required' }
  | { email: string | null; status: 'verified' }
  | { status: 'not-configured' }
  | { status: 'missing' }
  | { reason: string; status: 'invalid' }

/**
 * Production requires Access, and so does any Worker whose environment is not explicitly
 * `local` or `staging`, so a missing or misspelled `SITE_ENVIRONMENT` fails closed.
 */
export function accessRequired(env: AccessEnv): boolean {
  const environment = parseSiteEnvironment(env.SITE_ENVIRONMENT)
  if (environment === 'local' || environment === 'staging') return env.CF_ACCESS_REQUIRED === 'on'
  return true
}

/** The verification settings, or null when the team domain or AUD tag is unset or malformed. */
export function accessConfig(env: AccessEnv): AccessConfig | null {
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//u, '')
    .replace(/\/$/u, '')
  const audience = (env.CF_ACCESS_AUD ?? '').trim().toLowerCase()
  if (!TEAM_DOMAIN_PATTERN.test(teamDomain) || !AUD_PATTERN.test(audience)) return null
  return {
    audience,
    certsUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    issuer: `https://${teamDomain}`
  }
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>()

function remoteKeySet(certsUrl: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(certsUrl)
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(certsUrl), {
      cacheMaxAge: 60 * 60 * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000
    })
    remoteKeySets.set(certsUrl, keySet)
  }
  return keySet
}

export interface VerifyAccessOptions {
  /** Key resolver; defaults to the team's remote JWKS. Tests pass a local key set. */
  getKey?: (config: AccessConfig) => JWTVerifyGetKey
  /** Verification time; defaults to now. */
  now?: Date
}

export async function verifyAccessRequest(
  request: Request,
  env: AccessEnv,
  options: VerifyAccessOptions = {}
): Promise<AccessDecision> {
  if (!accessRequired(env)) return { status: 'not-required' }
  const config = accessConfig(env)
  if (!config) return { status: 'not-configured' }
  const token = request.headers.get(ACCESS_JWT_HEADER)?.trim()
  if (!token) return { status: 'missing' }
  const getKey = (options.getKey ?? (value => remoteKeySet(value.certsUrl)))(config)
  try {
    const { payload } = await jwtVerify(token, getKey, {
      algorithms: ['RS256'],
      audience: config.audience,
      clockTolerance: 30,
      currentDate: options.now,
      issuer: config.issuer,
      requiredClaims: ['exp', 'iat']
    })
    return { email: typeof payload.email === 'string' ? payload.email : null, status: 'verified' }
  } catch (error) {
    const reason =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'ERR_JWT_INVALID'
    return { reason, status: 'invalid' }
  }
}
