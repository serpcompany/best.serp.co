/**
 * Staging's admin key for agents (serpcompany/best.serp.co#408): accepted only on staging, only
 * on `/api/admin/*`, only with a configured secret of at least 32 characters and a header equal
 * to it; refused everywhere else, and never logged or echoed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizationErrorResponse } from './guards'
import {
  authorizeStagingAdminKey,
  hasStagingAdminKey,
  isAdminApiPath,
  isAllowlistApiPath,
  STAGING_ADMIN_ACTOR,
  STAGING_ADMIN_KEY_HEADER,
  type StagingAdminKeyEnv,
  stagingAdminKeyDecision,
  stagingAdminKeyMatches
} from './staging-admin-key'

/** A test value only; the real key is a staging Worker secret and is never in the repository. */
const KEY = 'unit-test-staging-admin-key-0123456789abcdef'
const staging: StagingAdminKeyEnv = {
  D1_RUNTIME_ENV: 'staging',
  SITE_ENVIRONMENT: 'staging',
  STAGING_ADMIN_TOKEN: KEY
}
const ORIGIN = 'https://staging.best.serp.co'

function keyed(path: string, key: string | null = KEY, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (key !== null) headers.set(STAGING_ADMIN_KEY_HEADER, key)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

afterEach(() => vi.restoreAllMocks())

describe('staging admin key', () => {
  it('accepts the right key on staging, on every /api/admin path', async () => {
    for (const path of [
      '/api/admin',
      '/api/admin/',
      '/api/admin/submissions/sub_1/approve',
      '/API/Admin/admins',
      '/api//admin/listings/lst_1/tags',
      '/api/%61dmin/listings/lst_1/tags'
    ]) {
      expect(
        await stagingAdminKeyMatches(keyed(path, KEY, { method: 'POST' }), staging),
        path
      ).toBe(true)
    }
    // The header name is case-insensitive, like every header.
    const upper = new Request(`${ORIGIN}/api/admin/listings/lst_1/tags`, {
      headers: { 'X-Staging-Admin-Token': KEY }
    })
    expect(await stagingAdminKeyMatches(upper, staging)).toBe(true)
  })

  it('acts as the fixed actor staging-agent, without a session', async () => {
    expect(
      await authorizeStagingAdminKey(keyed('/api/admin/listings/lst_1/tags'), staging)
    ).toEqual({
      ok: true,
      sessionId: null,
      user: {
        email: 'staging-agent',
        emailVerified: true,
        id: 'staging-agent',
        name: 'Staging agent',
        role: 'admin'
      }
    })
    expect(STAGING_ADMIN_ACTOR).toBe('staging-agent')
    expect(STAGING_ADMIN_ACTOR).not.toContain('@')
  })

  it('forbids the allowlist: the right key on /api/admin/admins is 403, never an admin', async () => {
    for (const path of [
      '/api/admin/admins',
      '/api/admin/admins/',
      '/API/Admin/Admins',
      '/api//admin/admins',
      '/api/admin/%61dmins',
      '/api/admin/admins/devin@serp.co'
    ]) {
      const request = keyed(path, KEY, { method: 'POST' })
      expect(await stagingAdminKeyMatches(request, staging), path).toBe(true)
      expect(await stagingAdminKeyDecision(request, staging), path).toBe('forbidden')
      expect(await authorizeStagingAdminKey(request, staging), path).toEqual({
        ok: false,
        reason: 'admin_key_forbidden',
        status: 403
      })
    }
    // A wrong key is refused there first, as anywhere.
    expect(
      await authorizeStagingAdminKey(keyed('/api/admin/admins', `${KEY}x`), staging)
    ).toMatchObject({ reason: 'admin_key_rejected', status: 401 })
    for (const path of ['/api/admin/adminsx', '/api/admin/listings/admins', '/admin/admins/']) {
      expect(isAllowlistApiPath(path), path).toBe(false)
    }
    expect(await stagingAdminKeyDecision(keyed('/api/admin/listings/lst_1/tags'), staging)).toBe(
      'admitted'
    )
    const answer = authorizationErrorResponse({
      ok: false,
      reason: 'admin_key_forbidden',
      status: 403
    })
    expect(answer.status).toBe(403)
    expect(await answer.json()).toEqual({
      error: 'admin_key_forbidden',
      message: 'The staging admin key can’t change admins.'
    })
  })

  it('refuses a wrong, partial, padded, empty or missing key', async () => {
    for (const key of [
      `${KEY.slice(0, -1)}x`,
      KEY.slice(0, -1),
      `${KEY}x`,
      KEY.toUpperCase(),
      `Bearer ${KEY}`,
      '',
      null
    ]) {
      const request = keyed('/api/admin/listings/lst_1/tags', key)
      expect(await stagingAdminKeyMatches(request, staging), String(key)).toBe(false)
      expect(await authorizeStagingAdminKey(request, staging)).toEqual({
        ok: false,
        reason: 'admin_key_rejected',
        status: 401
      })
    }
    expect(hasStagingAdminKey(keyed('/api/admin/listings/lst_1/tags', ''))).toBe(true)
    expect(hasStagingAdminKey(keyed('/api/admin/listings/lst_1/tags', null))).toBe(false)
  })

  it('refuses every key while the secret is missing, empty, or shorter than 32 characters', async () => {
    const short = 'a'.repeat(31)
    for (const secret of [undefined, '', '   ', short, ` ${short} `]) {
      const env = { ...staging, STAGING_ADMIN_TOKEN: secret }
      for (const key of [secret ?? '', short, KEY]) {
        expect(
          await stagingAdminKeyMatches(keyed('/api/admin/listings/lst_1/tags', key), env)
        ).toBe(false)
      }
    }
    // 32 characters is enough.
    const minimum = 'b'.repeat(32)
    const env = { ...staging, STAGING_ADMIN_TOKEN: minimum }
    expect(
      await stagingAdminKeyMatches(keyed('/api/admin/listings/lst_1/tags', minimum), env)
    ).toBe(true)
  })

  it('refuses any key in production and locally, even with the secret set (fail closed)', async () => {
    const elsewhere = [
      { ...staging, D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' },
      { ...staging, D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      // A local Worker serving as staging behind the password (`LOCAL_STAGING_ACCESS=on`).
      {
        ...staging,
        D1_RUNTIME_ENV: 'local',
        LOCAL_STAGING_ACCESS: 'on',
        SITE_ENVIRONMENT: 'local'
      },
      // Half staging is not staging.
      { ...staging, D1_RUNTIME_ENV: 'production' },
      { ...staging, SITE_ENVIRONMENT: 'production' },
      { ...staging, D1_RUNTIME_ENV: undefined },
      { ...staging, SITE_ENVIRONMENT: undefined },
      { ...staging, SITE_ENVIRONMENT: 'Staging' },
      { ...staging, D1_RUNTIME_ENV: ' staging' },
      { STAGING_ADMIN_TOKEN: KEY }
    ] as StagingAdminKeyEnv[]
    for (const env of elsewhere) {
      const request = keyed('/api/admin/submissions/sub_1/approve', KEY, { method: 'POST' })
      expect(await stagingAdminKeyMatches(request, env), JSON.stringify(env)).toBe(false)
      expect(await authorizeStagingAdminKey(request, env)).toMatchObject({
        ok: false,
        status: 401
      })
    }
  })

  it('never opens a page or any path outside /api/admin', async () => {
    for (const path of [
      '/admin/',
      '/admin/submissions/',
      '/api/adminx',
      '/api/administrators/',
      '/api/auth/get-session',
      '/api/account/listings/lst_1/edit',
      '/api/%E0%A4%A/admin'
    ]) {
      expect(await stagingAdminKeyMatches(keyed(path), staging), path).toBe(false)
    }
    expect(isAdminApiPath('/%')).toBe(false)
  })

  it('never logs the key or echoes it in an answer', async () => {
    const calls: unknown[][] = []
    for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args)
      })
    }
    const refused = await authorizeStagingAdminKey(
      keyed('/api/admin/listings/lst_1/tags', `${KEY}-wrong`),
      {
        ...staging
      }
    )
    await authorizeStagingAdminKey(keyed('/api/admin/listings/lst_1/tags'), staging)
    await authorizeStagingAdminKey(keyed('/api/admin/listings/lst_1/tags'), {
      ...staging,
      SITE_ENVIRONMENT: 'production'
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    const answer = authorizationErrorResponse(refused)
    expect(answer.status).toBe(401)
    expect(answer.headers.get('set-cookie')).toBeNull()
    const body = await answer.text()
    expect(JSON.parse(body)).toEqual({
      error: 'admin_key_rejected',
      message: 'The staging admin key was refused.'
    })
    expect(body).not.toContain(KEY)
    expect(JSON.stringify(calls)).not.toContain(KEY)
  })
})
