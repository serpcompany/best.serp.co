/**
 * The browser side of email-code sign-in (serpcompany/best.serp.co#60): calls the three
 * `/api/auth` endpoints and turns each answer into one UI outcome (docs/ACCOUNTS.md).
 *
 * A code request answers 200 whether or not a per-email limit stopped the email, so `sent`
 * only means "if the address is valid, a code is on its way". Only per-client limits answer
 * 429. Requests are same-origin, so the browser sends the cookies (including the code
 * binding) and the `Origin` Better Auth checks.
 */

import {
  SIGN_IN_CODE_ATTEMPTS,
  SIGN_IN_CODE_LENGTH,
  SIGN_IN_CODE_TTL_SECONDS
} from '../../lib/email/sign-in-code'

/** The code contract Better Auth enforces (`lib/email/sign-in-code.ts`). */
export const CODE_LENGTH = SIGN_IN_CODE_LENGTH
export const CODE_LIFETIME_SECONDS = SIGN_IN_CODE_TTL_SECONDS
export const CODE_LIFETIME_MINUTES = Math.ceil(SIGN_IN_CODE_TTL_SECONDS / 60)
export const CODE_ATTEMPTS = SIGN_IN_CODE_ATTEMPTS
/** One code a minute per email and client; the resend link waits this long. */
export const RESEND_COOLDOWN_SECONDS = 60

export type CodeRequestOutcome =
  | { kind: 'sent' }
  | { kind: 'invalid-email' }
  | { kind: 'limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' }
  | { kind: 'failed' }

export type SignInOutcome =
  | { kind: 'signed-in'; email: string }
  | { kind: 'wrong' }
  | { kind: 'expired' }
  | { kind: 'attempts' }
  | { kind: 'limited'; retryAfterSeconds: number }
  | { kind: 'failed' }

type Fetch = typeof fetch

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : ''
  } catch {
    return ''
  }
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60
}

function post(fetcher: Fetch, path: string, body: unknown): Promise<Response> {
  return fetcher(`/api/auth${path}`, {
    body: JSON.stringify(body),
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
}

export async function requestCode(
  email: string,
  fetcher: Fetch = fetch
): Promise<CodeRequestOutcome> {
  let response: Response
  try {
    response = await post(fetcher, '/email-otp/send-verification-otp', { email, type: 'sign-in' })
  } catch {
    return { kind: 'failed' }
  }
  if (response.ok) return { kind: 'sent' }
  if (response.status === 429) return { kind: 'limited', retryAfterSeconds: retryAfter(response) }
  const code = await errorCode(response)
  if (response.status === 503 && code === 'OTP_DELIVERY_UNAVAILABLE') return { kind: 'unavailable' }
  if (response.status === 400 && code === 'INVALID_EMAIL') return { kind: 'invalid-email' }
  return { kind: 'failed' }
}

export async function verifyCode(
  email: string,
  otp: string,
  fetcher: Fetch = fetch
): Promise<SignInOutcome> {
  let response: Response
  try {
    response = await post(fetcher, '/sign-in/email-otp', { email, otp })
  } catch {
    return { kind: 'failed' }
  }
  if (response.ok) {
    try {
      const body = (await response.json()) as { user?: { email?: unknown } }
      return {
        email: typeof body.user?.email === 'string' ? body.user.email : email,
        kind: 'signed-in'
      }
    } catch {
      return { email, kind: 'signed-in' }
    }
  }
  if (response.status === 429) return { kind: 'limited', retryAfterSeconds: retryAfter(response) }
  const code = await errorCode(response)
  if (code === 'OTP_EXPIRED') return { kind: 'expired' }
  if (code === 'TOO_MANY_ATTEMPTS') return { kind: 'attempts' }
  if (code === 'INVALID_OTP') return { kind: 'wrong' }
  return { kind: 'failed' }
}

/** Ends the session. Resolves true when the server confirmed it. */
export async function signOut(fetcher: Fetch = fetch): Promise<boolean> {
  try {
    return (await post(fetcher, '/sign-out', {})).ok
  } catch {
    return false
  }
}

/** "45 seconds", "1 minute", "38 minutes", "1 hour". */
export function formatWait(seconds: number): string {
  if (seconds < 60) {
    const whole = Math.max(1, Math.ceil(seconds))
    return `${whole} ${whole === 1 ? 'second' : 'seconds'}`
  }
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.ceil(minutes / 60)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/** "0:42" for the resend countdown. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
