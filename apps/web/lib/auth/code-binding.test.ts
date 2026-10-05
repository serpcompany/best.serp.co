import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CODE_BINDING_MAX_AGE_SECONDS,
  clearCodeBindingSetCookie,
  codeBindingCookieName,
  codeBindingCookieOptions,
  decoyCodeBinding,
  findCodeBinding,
  hashOtp,
  issueCodeBinding,
  readCodeBindingTokens,
  verifyCodeBinding
} from './code-binding'
import { CODE_BINDING_KEY_LABEL, deriveKey, KNOWN_DEVICE_KEY_LABEL } from './keys'

const SECRET = 'code-binding-test-secret-'.repeat(2)
const now = new Date('2026-10-06T12:00:00.000Z')
const code = { email: 'owner@example.com', storedOtp: 'stored-hash-of-482913' }

describe('code bindings', () => {
  it('store codes as Better Auth hashes them: SHA-256, base64url without padding', async () => {
    expect(await hashOtp('482913')).toBe(createHash('sha256').update('482913').digest('base64url'))
    expect(await hashOtp('482913')).not.toBe(await hashOtp('482914'))
  })

  it('verify only for the email and stored code they were issued for, until they expire', async () => {
    const key = await deriveKey(SECRET, CODE_BINDING_KEY_LABEL)
    const token = await issueCodeBinding(key, code, now)
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/u)
    expect(await verifyCodeBinding(key, token, code, now)).toBe(true)
    // A newer code for the same email (a new stored hash) does not match.
    expect(await verifyCodeBinding(key, token, { ...code, storedOtp: 'newer' }, now)).toBe(false)
    expect(await verifyCodeBinding(key, token, { ...code, email: 'other@example.com' }, now)).toBe(
      false
    )
    const late = new Date(now.getTime() + (CODE_BINDING_MAX_AGE_SECONDS - 1) * 1000)
    expect(await verifyCodeBinding(key, token, code, late)).toBe(true)
    const expired = new Date(now.getTime() + CODE_BINDING_MAX_AGE_SECONDS * 1000)
    expect(await verifyCodeBinding(key, token, code, expired)).toBe(false)
  })

  it('reject other keys, decoys, tampering, and malformed values', async () => {
    const key = await deriveKey(SECRET, CODE_BINDING_KEY_LABEL)
    const token = await issueCodeBinding(key, code, now)
    const other = await deriveKey(SECRET, KNOWN_DEVICE_KEY_LABEL)
    expect(await verifyCodeBinding(other, token, code, now)).toBe(false)
    const [exp, mac] = token.split('.')
    for (const candidate of [
      decoyCodeBinding(now),
      '',
      'abc',
      `${exp}.`,
      `.${mac}`,
      `${Number(exp) + 60}.${mac}`,
      `${exp}.${mac}=`,
      `${exp}.${mac}.x`,
      `${exp}.${mac?.startsWith('A') ? 'B' : 'A'}${mac?.slice(1)}`,
      `99999999999.${mac}`
    ]) {
      expect(await verifyCodeBinding(key, candidate, code, now), candidate).toBe(false)
    }
    // A decoy is shaped like a real binding, so a response cannot tell them apart.
    expect(decoyCodeBinding(now)).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/u)
    expect(decoyCodeBinding(now).split('.')[0]).toBe(exp)
  })

  it('find a matching binding among several same-named cookies', async () => {
    const key = await deriveKey(SECRET, CODE_BINDING_KEY_LABEL)
    const token = await issueCodeBinding(key, code, now)
    const name = codeBindingCookieName(true)
    const tokens = readCodeBindingTokens(`${name}=planted; a=1; ${name}=${token}`, true)
    expect(tokens).toEqual(['planted', token])
    expect(await findCodeBinding(key, tokens, code, now)).toBe(token)
    expect(await findCodeBinding(key, ['planted'], code, now)).toBeNull()
    expect(readCodeBindingTokens(`${name}=${token}`, false)).toEqual([])
  })

  it('live in an HttpOnly, SameSite=Strict cookie scoped to /api/auth', () => {
    expect(codeBindingCookieName(false)).toBe('bsc_code_binding')
    expect(codeBindingCookieName(true)).toBe('__Secure-bsc_code_binding')
    expect(codeBindingCookieOptions(true)).toEqual({
      httpOnly: true,
      maxAge: CODE_BINDING_MAX_AGE_SECONDS,
      path: '/api/auth',
      sameSite: 'strict',
      secure: true
    })
    expect(CODE_BINDING_MAX_AGE_SECONDS).toBe(15 * 60)
    expect(clearCodeBindingSetCookie(true)).toBe(
      '__Secure-bsc_code_binding=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Strict'
    )
  })
})
