import type { AdminStatus } from '@/db/auth'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizationErrorResponse,
  authorizeAdmin,
  authorizeUser,
  checkAdminRequestOrigin,
  type SessionSnapshot
} from './guards'
import { isTrustedOrigin } from './settings'

const now = new Date('2026-10-06T12:00:00.000Z')
const later = new Date('2026-10-13T12:00:00.000Z')

function snapshot(overrides: Partial<SessionSnapshot['user']> = {}): SessionSnapshot {
  return {
    session: { expiresAt: later, id: 'session-1' },
    user: {
      email: 'devin@serp.co',
      emailVerified: true,
      id: 'user-1',
      name: '',
      role: 'admin',
      ...overrides
    }
  }
}

const admin: AdminStatus = {
  allowlisted: true,
  email: 'devin@serp.co',
  emailVerified: true,
  role: 'admin'
}

describe('requireUser decisions', () => {
  it('admits a verified, unexpired session', async () => {
    const result = await authorizeUser({ getSession: async () => snapshot(), now: () => now })
    expect(result).toEqual({ ok: true, sessionId: 'session-1', user: snapshot().user })
  })

  it('answers 401 without a usable session', async () => {
    const expired = { ...snapshot(), session: { expiresAt: now, id: 'session-1' } }
    for (const session of [
      null,
      expired,
      snapshot({ emailVerified: false }),
      { ...snapshot(), session: { expiresAt: 'not a date', id: 's' } }
    ]) {
      expect(
        await authorizeUser({ getSession: async () => session, now: () => now })
      ).toMatchObject({ ok: false, reason: 'session_required', status: 401 })
    }
  })

  it('answers 503 when accounts cannot be checked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await authorizeUser({
      getSession: async () => {
        throw new Error('BETTER_AUTH_SECRET must be set')
      }
    })
    expect(result).toMatchObject({ ok: false, reason: 'auth_unavailable', status: 503 })
    error.mockRestore()
  })
})

describe('requireAdmin decisions', () => {
  const run = (status: AdminStatus | null, session: SessionSnapshot | null = snapshot()) =>
    authorizeAdmin({
      getAdminStatus: async () => status,
      getSession: async () => session,
      now: () => now
    })

  it('admits a signed-in user who is on the allowlist with the admin role', async () => {
    expect(await run(admin)).toMatchObject({ ok: true, user: { id: 'user-1' } })
  })

  it('answers 401 to anonymous visitors before reading the allowlist', async () => {
    const getAdminStatus = vi.fn(async () => admin)
    const result = await authorizeAdmin({ getAdminStatus, getSession: async () => null })
    expect(result).toMatchObject({ status: 401 })
    expect(getAdminStatus).not.toHaveBeenCalled()
  })

  it('answers 403 to every signed-in user who is not a current admin', async () => {
    for (const status of [
      null,
      { ...admin, allowlisted: false },
      { ...admin, role: 'user' as const },
      { ...admin, emailVerified: false },
      { ...admin, email: 'someone@example.com' }
    ]) {
      expect(await run(status), JSON.stringify(status)).toMatchObject({
        ok: false,
        reason: 'admin_required',
        status: 403
      })
    }
  })

  it('answers 503 when the allowlist cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await authorizeAdmin({
      getAdminStatus: async () => {
        throw new Error('D1 unavailable')
      },
      getSession: async () => snapshot()
    })
    expect(result).toMatchObject({ status: 503 })
    error.mockRestore()
  })

  it('renders JSON errors that are never cached', async () => {
    const response = authorizationErrorResponse({
      ok: false,
      reason: 'admin_required',
      status: 403
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      error: 'admin_required',
      message: 'Admin access required.'
    })
  })
})

describe('admin request origin', () => {
  const production = (origin: string | null) => isTrustedOrigin(origin, ['https://best.serp.co'])
  const request = (method: string, origin?: string) =>
    new Request('https://best.serp.co/api/admin/x', {
      headers: origin ? { origin } : {},
      method
    })

  it('lets safe methods through without an Origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkAdminRequestOrigin(request(method), production), method).toBeNull()
    }
  })

  it('requires a trusted Origin on every state-changing method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        checkAdminRequestOrigin(request(method, 'https://best.serp.co'), production)
      ).toBeNull()
      // Same-site siblings (any *.serp.co) are not trusted.
      for (const origin of [
        undefined,
        'null',
        'https://other.serp.co',
        'https://best.serp.co.evil.example',
        'http://best.serp.co'
      ]) {
        expect(
          checkAdminRequestOrigin(request(method, origin), production),
          `${method} ${origin}`
        ).toMatchObject({ reason: 'origin_rejected', status: 403 })
      }
    }
  })

  it('matches the local localhost patterns on any port only', () => {
    const local = ['http://localhost', 'http://localhost:*', 'http://127.0.0.1:*']
    expect(isTrustedOrigin('http://localhost:8978', local)).toBe(true)
    expect(isTrustedOrigin('http://127.0.0.1:3100', local)).toBe(true)
    expect(isTrustedOrigin('http://localhost', local)).toBe(true)
    expect(isTrustedOrigin('http://localhost:8978.evil.example', local)).toBe(false)
    expect(isTrustedOrigin('http://localhost.evil.example', local)).toBe(false)
    expect(isTrustedOrigin('https://localhost:8978', local)).toBe(false)
  })
})
