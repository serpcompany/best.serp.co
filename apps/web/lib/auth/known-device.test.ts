import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deriveKey, KNOWN_DEVICE_KEY_LABEL, RATE_LIMIT_KEY_LABEL } from './keys'
import {
  issueKnownDevice,
  KNOWN_DEVICE_MAX_AGE_SECONDS,
  knownDeviceCookieName,
  knownDeviceSetCookie,
  readKnownDeviceToken,
  verifyKnownDevice
} from './known-device'

const SECRET = 'known-device-test-secret-'.repeat(2)
const now = new Date('2026-10-06T12:00:00.000Z')

describe('derived keys', () => {
  it('gives each purpose its own key, never the secret itself', async () => {
    const rateLimit = await deriveKey(SECRET, RATE_LIMIT_KEY_LABEL)
    const knownDevice = await deriveKey(SECRET, KNOWN_DEVICE_KEY_LABEL)
    expect(rateLimit).toMatch(/^[a-f0-9]{64}$/u)
    expect(rateLimit).toBe(
      createHmac('sha256', SECRET).update('best.serp.co/auth-rate-limit/v1').digest('hex')
    )
    expect(knownDevice).not.toBe(rateLimit)
    expect(knownDevice).not.toBe(SECRET)
    expect(await deriveKey(`${SECRET}x`, KNOWN_DEVICE_KEY_LABEL)).not.toBe(knownDevice)
    await expect(deriveKey('', RATE_LIMIT_KEY_LABEL)).rejects.toThrow(/non-empty secret/u)
  })
})

describe('known-device tokens', () => {
  it('verify only for the user they were issued to, until they expire', async () => {
    const key = await deriveKey(SECRET, KNOWN_DEVICE_KEY_LABEL)
    const token = await issueKnownDevice(key, 'user-1', now)
    expect(await verifyKnownDevice(key, token, 'user-1', now)).toBe(true)
    expect(await verifyKnownDevice(key, token, 'user-2', now)).toBe(false)
    const later = new Date(now.getTime() + (KNOWN_DEVICE_MAX_AGE_SECONDS - 60) * 1000)
    expect(await verifyKnownDevice(key, token, 'user-1', later)).toBe(true)
    const expired = new Date(now.getTime() + (KNOWN_DEVICE_MAX_AGE_SECONDS + 1) * 1000)
    expect(await verifyKnownDevice(key, token, 'user-1', expired)).toBe(false)
    // Not yet valid (issued in the future beyond clock skew).
    const early = new Date(now.getTime() - 3600 * 1000)
    expect(await verifyKnownDevice(key, token, 'user-1', early)).toBe(false)
  })

  it('reject tokens signed with another key, tampered, or malformed', async () => {
    const key = await deriveKey(SECRET, KNOWN_DEVICE_KEY_LABEL)
    const other = await deriveKey(SECRET, RATE_LIMIT_KEY_LABEL)
    const token = await issueKnownDevice(key, 'user-1', now)
    expect(await verifyKnownDevice(other, token, 'user-1', now)).toBe(false)
    const [payload, mac] = token.split('.')
    const forgedPayload = Buffer.from(
      JSON.stringify({ exp: 9_999_999_999, iat: 0, u: 'user-1' })
    ).toString('base64url')
    for (const candidate of [
      undefined,
      '',
      'abc',
      `${payload}.`,
      `.${mac}`,
      `${forgedPayload}.${mac}`,
      `${payload}.${mac}.extra`,
      `${payload}.${mac?.slice(0, -2)}`,
      `${payload}.!!!`,
      'x'.repeat(600)
    ]) {
      expect(await verifyKnownDevice(key, candidate, 'user-1', now), String(candidate)).toBe(false)
    }
  })

  it('round-trips through the cookie it is stored in', async () => {
    const key = await deriveKey(SECRET, KNOWN_DEVICE_KEY_LABEL)
    const token = await issueKnownDevice(key, 'user-1', now)
    for (const secure of [false, true]) {
      const header = knownDeviceSetCookie(token, secure)
      expect(header.startsWith(`${knownDeviceCookieName(secure)}=${token};`)).toBe(true)
      expect(header).toContain(`Max-Age=${KNOWN_DEVICE_MAX_AGE_SECONDS}`)
      expect(header).toContain('Path=/api/auth')
      expect(header).toContain('HttpOnly')
      expect(header).toContain('SameSite=Strict')
      expect(header.includes('Secure')).toBe(secure)
      const cookie = `theme=dark; ${header.split(';')[0]}; other=1`
      expect(readKnownDeviceToken(cookie, secure)).toBe(token)
      // The secure and local names never read each other.
      expect(readKnownDeviceToken(cookie, !secure)).toBeUndefined()
    }
    expect(knownDeviceCookieName(true)).toBe('__Secure-bsc_known_device')
    expect(readKnownDeviceToken(null, false)).toBeUndefined()
  })
})
