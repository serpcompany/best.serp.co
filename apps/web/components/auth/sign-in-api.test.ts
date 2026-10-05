import { describe, expect, it, vi } from 'vitest'
import {
  OTP_ALLOWED_ATTEMPTS,
  OTP_EXPIRES_IN_SECONDS,
  OTP_LENGTH,
  OTP_REQUEST_LIMITS
} from '../../lib/auth/rate-limits'
import {
  CODE_ATTEMPTS,
  CODE_LENGTH,
  CODE_LIFETIME_MINUTES,
  CODE_LIFETIME_SECONDS,
  formatCountdown,
  formatWait,
  RESEND_COOLDOWN_SECONDS,
  requestCode,
  signOut,
  verifyCode
} from './sign-in-api'

// PR #76 review, finding 6: the screen reads the code contract Better Auth is configured with.
describe('the code contract', () => {
  it('matches what Better Auth enforces', () => {
    expect(CODE_LENGTH).toBe(OTP_LENGTH)
    expect(CODE_LIFETIME_SECONDS).toBe(OTP_EXPIRES_IN_SECONDS)
    expect(CODE_LIFETIME_MINUTES).toBe(10)
    expect(CODE_ATTEMPTS).toBe(OTP_ALLOWED_ATTEMPTS)
    expect(RESEND_COOLDOWN_SECONDS * 1000).toBe(OTP_REQUEST_LIMITS.emailCooldown.windowMs)
  })
})

function answer(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        headers: { 'content-type': 'application/json', ...headers },
        status
      })
  ) as unknown as typeof fetch & { mock: { calls: [string, RequestInit][] } }
}

describe('requesting a code', () => {
  it('posts the email as a sign-in code request from this origin', async () => {
    const fetcher = answer(200, { success: true })
    expect(await requestCode('owner@example.com', fetcher)).toEqual({ kind: 'sent' })
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('/api/auth/email-otp/send-verification-otp')
    expect(init).toMatchObject({ credentials: 'same-origin', method: 'POST' })
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'owner@example.com', type: 'sign-in' })
  })

  it('maps each answer to one outcome', async () => {
    expect(
      await requestCode('a@b.co', answer(429, { code: 'RATE_LIMITED' }, { 'retry-after': '2280' }))
    ).toEqual({ kind: 'limited', retryAfterSeconds: 2280 })
    expect(await requestCode('a@b.co', answer(429, {}))).toEqual({
      kind: 'limited',
      retryAfterSeconds: 60
    })
    expect(await requestCode('a@b.co', answer(503, { code: 'OTP_DELIVERY_UNAVAILABLE' }))).toEqual({
      kind: 'unavailable'
    })
    expect(await requestCode('nope', answer(400, { code: 'INVALID_EMAIL' }))).toEqual({
      kind: 'invalid-email'
    })
    expect(await requestCode('a@b.co', answer(500))).toEqual({ kind: 'failed' })
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await requestCode('a@b.co', offline)).toEqual({ kind: 'failed' })
  })
})

describe('verifying a code', () => {
  it('signs in and reports the account email', async () => {
    const fetcher = answer(200, { token: 't', user: { email: 'owner@example.com' } })
    expect(await verifyCode('Owner@Example.com', '482913', fetcher)).toEqual({
      email: 'owner@example.com',
      kind: 'signed-in'
    })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      email: 'Owner@Example.com',
      otp: '482913'
    })
  })

  it('tells a wrong, expired, or used-up code apart', async () => {
    const outcome = (status: number, code: string) =>
      verifyCode('a@b.co', '000000', answer(status, { code, message: 'x' }))
    expect(await outcome(400, 'INVALID_OTP')).toEqual({ kind: 'wrong' })
    expect(await outcome(400, 'OTP_EXPIRED')).toEqual({ kind: 'expired' })
    expect(await outcome(403, 'TOO_MANY_ATTEMPTS')).toEqual({ kind: 'attempts' })
    expect(await verifyCode('a@b.co', '000000', answer(429, {}, { 'retry-after': '30' }))).toEqual({
      kind: 'limited',
      retryAfterSeconds: 30
    })
    expect(await outcome(403, 'INVALID_ORIGIN')).toEqual({ kind: 'failed' })
  })
})

describe('signing out', () => {
  it('posts to sign-out and reports whether it worked', async () => {
    const fetcher = answer(200, { success: true })
    expect(await signOut(fetcher)).toBe(true)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/auth/sign-out')
    expect(await signOut(answer(403, {}))).toBe(false)
  })
})

describe('wait formatting', () => {
  it('says how long to wait in plain words', () => {
    expect(formatWait(1)).toBe('1 second')
    expect(formatWait(45)).toBe('45 seconds')
    expect(formatWait(60)).toBe('1 minute')
    expect(formatWait(2280)).toBe('38 minutes')
    expect(formatWait(3600)).toBe('1 hour')
    expect(formatCountdown(42)).toBe('0:42')
    expect(formatCountdown(60)).toBe('1:00')
    expect(formatCountdown(-3)).toBe('0:00')
  })
})
