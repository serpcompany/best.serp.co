/**
 * The code-binding cookie (serpcompany/best.serp.co#60, review round 3, finding 1): only the
 * browser that requested an email's current code may guess it. Better Auth allows three
 * guesses per code from anyone, so without this, three wrong guesses from any client would void
 * any code, including the one a known device just requested.
 *
 * Each code request answers with this cookie. Its value is `<exp>.<mac>`: the expiry in epoch
 * seconds and an HMAC-SHA256, under the key derived with `CODE_BINDING_KEY_LABEL` (`keys.ts`),
 * over the email, the stored hash of the code that request created, and the expiry. The stored
 * hash is the per-send nonce: every request creates a new code and hash, Better Auth keeps the
 * hash (and nothing else) for the code, and a wrong guess keeps it. So a cookie matches only
 * while its code is the email's latest, and a newer request for the email, from anyone,
 * replaces it.
 *
 * `/sign-in/email-otp` refuses a guess, before Better Auth counts it, unless one of the
 * request's binding cookies matches the email's latest code, and answers exactly as for a wrong
 * code. The cookie is HttpOnly, SameSite=Strict, scoped to `/api/auth`, and lasts the code's
 * ten minutes plus five, so a late guess still hears that the code expired.
 */

import { readCookieValues } from './cookies'
import { OTP_EXPIRES_IN_SECONDS } from './rate-limits'

export const CODE_BINDING_COOKIE = 'bsc_code_binding'
/** The code's lifetime plus five minutes, so a guess after expiry still hears "expired". */
export const CODE_BINDING_MAX_AGE_SECONDS = OTP_EXPIRES_IN_SECONDS + 5 * 60
const COOKIE_PATH = '/api/auth'
/** More same-named cookies than a browser plausibly holds are ignored past this many. */
const MAX_TOKENS_CHECKED = 8
const TOKEN_PATTERN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/u

const encoder = new TextEncoder()

/** The code a binding is for: the email as Better Auth keys it and the code's stored hash. */
export interface BoundCode {
  email: string
  storedOtp: string
}

export function codeBindingCookieName(secure: boolean): string {
  return secure ? `__Secure-${CODE_BINDING_COOKIE}` : CODE_BINDING_COOKIE
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * How a code is stored (`storeOTP.hash` in `config.ts`): SHA-256, base64url without padding,
 * the same digest as Better Auth's built-in `hashed` mode. Owning it lets the code request bind
 * its cookie to the stored hash without reading the row back.
 */
export async function hashOtp(otp: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(otp))))
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

function message({ email, storedOtp }: BoundCode, exp: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(`v1\0${email}\0${storedOtp}\0${exp}`)
}

function expiry(now: Date): number {
  return Math.floor(now.getTime() / 1000) + CODE_BINDING_MAX_AGE_SECONDS
}

/** A binding for `code`, issued at `now`. */
export async function issueCodeBinding(key: string, code: BoundCode, now: Date): Promise<string> {
  const exp = expiry(now)
  const mac = await crypto.subtle.sign('HMAC', await macKey(key), message(code, exp))
  return `${exp}.${base64url(new Uint8Array(mac))}`
}

/**
 * A value shaped like a binding that matches no code. A code request that sends nothing
 * answers with it (unless the browser holds a binding for the email's current code), so the
 * response looks the same as one that sent a code.
 */
export function decoyCodeBinding(now: Date): string {
  return `${expiry(now)}.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
}

/** True only for an untampered, unexpired binding for exactly `code`. */
export async function verifyCodeBinding(
  key: string,
  token: string,
  code: BoundCode,
  now: Date
): Promise<boolean> {
  const match = TOKEN_PATTERN.exec(token)
  if (!match) return false
  const exp = Number(match[1])
  const seconds = Math.floor(now.getTime() / 1000)
  if (exp <= seconds || exp > seconds + CODE_BINDING_MAX_AGE_SECONDS + 300) return false
  return crypto.subtle.verify(
    'HMAC',
    await macKey(key),
    fromBase64url(match[2] ?? ''),
    message(code, exp)
  )
}

/** The first of `tokens` that binds `code`, or null. */
export async function findCodeBinding(
  key: string,
  tokens: readonly string[],
  code: BoundCode,
  now: Date
): Promise<string | null> {
  for (const token of tokens.slice(0, MAX_TOKENS_CHECKED)) {
    if (await verifyCodeBinding(key, token, code, now)) return token
  }
  return null
}

/** Every binding in a `Cookie` header (a sibling site can plant extra same-named cookies). */
export function readCodeBindingTokens(
  cookieHeader: string | null | undefined,
  secure: boolean
): string[] {
  return readCookieValues(cookieHeader, codeBindingCookieName(secure))
}

/** Cookie attributes for `ctx.setCookie`: HttpOnly, SameSite=Strict, `/api/auth` only. */
export function codeBindingCookieOptions(secure: boolean, maxAge = CODE_BINDING_MAX_AGE_SECONDS) {
  return { httpOnly: true, maxAge, path: COOKIE_PATH, sameSite: 'strict', secure } as const
}

/** The `Set-Cookie` value that removes the binding (after the code signs in). */
export function clearCodeBindingSetCookie(secure: boolean): string {
  return [
    `${codeBindingCookieName(secure)}=`,
    'Max-Age=0',
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Strict'
  ].join('; ')
}
