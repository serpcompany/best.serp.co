/**
 * The known-device cookie (serpcompany/best.serp.co#60, review round 2): set after a successful
 * sign-in, it lets that browser request its account's next code under its own per-email
 * ceiling, so an attacker who floods an email from many addresses cannot lock its owner out.
 *
 * The value is `<payload>.<mac>`: a base64url JSON payload `{ u, iat, exp }` (user id, issued
 * and expiry times in seconds) and its HMAC-SHA256 under the key derived with
 * `KNOWN_DEVICE_KEY_LABEL` (`keys.ts`). It is HttpOnly, SameSite=Strict, scoped to `/api/auth`
 * (so pages and the edge cache never see it), and lasts 180 days. It grants no session: it only
 * changes which code limits apply, and only for the account whose id it carries.
 */

import { readCookieValues } from './cookies'

export const KNOWN_DEVICE_COOKIE = 'bsc_known_device'
export const KNOWN_DEVICE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60
const COOKIE_PATH = '/api/auth'
const CLOCK_SKEW_SECONDS = 300
/** More same-named cookies than a browser plausibly holds are ignored past this many. */
const MAX_TOKENS_CHECKED = 8

const encoder = new TextEncoder()

interface KnownDeviceClaims {
  exp: number
  iat: number
  u: string
}

export function knownDeviceCookieName(secure: boolean): string {
  return secure ? `__Secure-${KNOWN_DEVICE_COOKIE}` : KNOWN_DEVICE_COOKIE
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null
  try {
    const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

function macKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify']
  )
}

/** A signed token for `userId`, issued at `now` and valid for 180 days. */
export async function issueKnownDevice(key: string, userId: string, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  const claims: KnownDeviceClaims = { exp: iat + KNOWN_DEVICE_MAX_AGE_SECONDS, iat, u: userId }
  const payload = base64url(encoder.encode(JSON.stringify(claims)))
  const mac = await crypto.subtle.sign('HMAC', await macKey(key), encoder.encode(payload))
  return `${payload}.${base64url(new Uint8Array(mac))}`
}

/** True only for an untampered, unexpired token issued for `userId`. */
export async function verifyKnownDevice(
  key: string,
  token: string | undefined,
  userId: string,
  now: Date
): Promise<boolean> {
  if (!token || token.length > 512) return false
  const [payload, mac, extra] = token.split('.')
  if (!payload || !mac || extra !== undefined) return false
  const signature = fromBase64url(mac)
  if (!signature) return false
  const valid = await crypto.subtle.verify(
    'HMAC',
    await macKey(key),
    signature,
    encoder.encode(payload)
  )
  if (!valid) return false
  let claims: Partial<KnownDeviceClaims>
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload) ?? new Uint8Array()))
  } catch {
    return false
  }
  const seconds = Math.floor(now.getTime() / 1000)
  return (
    claims.u === userId &&
    typeof claims.exp === 'number' &&
    typeof claims.iat === 'number' &&
    claims.exp > seconds &&
    claims.iat <= seconds + CLOCK_SKEW_SECONDS
  )
}

/**
 * Every known-device token in a `Cookie` header. A sibling `*.serp.co` site can plant a
 * same-named cookie that the browser sends first, so callers accept any token that verifies.
 */
export function readKnownDeviceTokens(
  cookieHeader: string | null | undefined,
  secure: boolean
): string[] {
  return readCookieValues(cookieHeader, knownDeviceCookieName(secure))
}

/** True when any of `tokens` verifies for `userId` (`verifyKnownDevice`). */
export async function anyKnownDevice(
  key: string,
  tokens: readonly string[],
  userId: string,
  now: Date
): Promise<boolean> {
  for (const token of tokens.slice(0, MAX_TOKENS_CHECKED)) {
    if (await verifyKnownDevice(key, token, userId, now)) return true
  }
  return false
}

/** The `Set-Cookie` value that stores `token` for 180 days. */
export function knownDeviceSetCookie(token: string, secure: boolean): string {
  return [
    `${knownDeviceCookieName(secure)}=${token}`,
    `Max-Age=${KNOWN_DEVICE_MAX_AGE_SECONDS}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}
