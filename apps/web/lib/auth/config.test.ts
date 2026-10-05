/**
 * The real Better Auth configuration (`config.ts`) against SQLite with the checked-in
 * migrations: request a code, sign in, read the session, sign out; abuse limits; the attempt
 * cap; roles from the allowlist; and the fail-closed staging and production behavior.
 */
import { createAuthOperations } from '@serpdirectory/data-ops/auth'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { SqliteD1 } from '@serpdirectory/data-ops/test-support'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_AUTH_ENDPOINTS,
  type Auth,
  createAuth,
  DEV_AUTH_ENDPOINTS,
  DEV_OTP_OUTBOX_PATH,
  MAX_NAME_LENGTH
} from './config'
import { AUTH_COOKIE_PREFIX, hasSessionCookie } from './cookies'
import { authorizeAdmin } from './guards'
import {
  clearDevOtpOutbox,
  createDevOtpSender,
  type OtpMessage,
  type OtpSender,
  unavailableOtpSender
} from './otp-sender'
import { OTP_REQUEST_LIMITS } from './rate-limits'
import { resolveAuthSettings } from './settings'

const LOCAL_ORIGIN = 'http://localhost:8978'
const STAGING_ORIGIN = 'https://best-serp-co-staging.serpcompany.workers.dev'
const SECRET = 'test-secret-'.repeat(4)

interface Harness {
  auth: Auth
  call(path: string, init?: CallInit): Promise<Response>
  operations: ReturnType<typeof createAuthOperations>
  origin: string
  sqlite: SqliteD1
}

interface CallInit {
  body?: unknown
  cookie?: string
  ip?: string
  method?: string
  origin?: string | null
}

function harness(options: { environment?: 'local' | 'staging'; sender?: OtpSender } = {}): Harness {
  const environment = options.environment ?? 'local'
  const sqlite = new SqliteD1()
  const client = createDatabase(sqlite.asD1Database())
  const operations = createAuthOperations({ client, rateLimitKey: SECRET })
  const settings = resolveAuthSettings(
    environment === 'local'
      ? { BETTER_AUTH_SECRET: SECRET, D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }
      : {
          BETTER_AUTH_SECRET: SECRET,
          BETTER_AUTH_TRUSTED_ORIGINS: STAGING_ORIGIN,
          BETTER_AUTH_URL: STAGING_ORIGIN,
          D1_RUNTIME_ENV: 'staging',
          SITE_ENVIRONMENT: 'staging'
        }
  )
  const origin = environment === 'local' ? LOCAL_ORIGIN : STAGING_ORIGIN
  const auth = createAuth({
    client,
    operations,
    sender: options.sender ?? createDevOtpSender(() => {}),
    settings
  })
  return {
    auth,
    async call(path, init = {}) {
      const headers = new Headers({ 'cf-connecting-ip': init.ip ?? '203.0.113.10' })
      if (init.origin !== null) headers.set('origin', init.origin ?? origin)
      if (init.cookie) headers.set('cookie', init.cookie)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      return auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          headers,
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST')
        })
      )
    },
    operations,
    origin,
    sqlite
  }
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map(header => header.split(';')[0] ?? '')
    .find(pair => hasSessionCookie(pair))
  if (!cookie) throw new Error('No session cookie was set.')
  return cookie
}

async function requestCode(h: Harness, email: string, ip?: string): Promise<string> {
  const response = await h.call('/email-otp/send-verification-otp', {
    body: { email, type: 'sign-in' },
    ip
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const outbox = await h.call(`${DEV_OTP_OUTBOX_PATH}?email=${encodeURIComponent(email)}`)
  const { otp } = (await outbox.json()) as { otp: string | null }
  expect(otp).toMatch(/^\d{6}$/u)
  return otp as string
}

async function signIn(h: Harness, email: string, ip?: string): Promise<string> {
  return (await signInWithDevice(h, email, ip)).session
}

/** Signs in and returns the session cookie and the known-device cookie, as `name=value`. */
async function signInWithDevice(
  h: Harness,
  email: string,
  ip?: string
): Promise<{ device: string; session: string }> {
  const otp = await requestCode(h, email, ip)
  const response = await h.call('/sign-in/email-otp', { body: { email, otp }, ip })
  expect(response.status, await response.clone().text()).toBe(200)
  const device = response.headers
    .getSetCookie()
    .map(header => header.split(';')[0] ?? '')
    .find(pair => /^(?:__Secure-)?bsc_known_device=/u.test(pair))
  if (!device) throw new Error('No known-device cookie was set.')
  return { device, session: sessionCookie(response) }
}

beforeEach(() => clearDevOtpOutbox())

describe('email OTP sign-in', () => {
  it('requests a code, signs in, reads the session, and signs out', async () => {
    const h = harness()
    const otp = await requestCode(h, 'Visitor@Example.com')
    // Only a hash of the code is stored.
    const stored = h.sqlite.database.prepare('SELECT identifier, value FROM verification').all()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(otp)

    const signedIn = await h.call('/sign-in/email-otp', {
      body: { email: 'visitor@example.com', otp }
    })
    expect(signedIn.status).toBe(200)
    const cookie = sessionCookie(signedIn)
    expect(cookie.startsWith(`${AUTH_COOKIE_PREFIX}.session_token=`)).toBe(true)
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM verification').get()).toEqual({
      n: 0
    })

    const user = h.sqlite.database
      .prepare('SELECT email, email_verified, role FROM users')
      .get() as Record<string, unknown>
    expect({ ...user }).toEqual({ email: 'visitor@example.com', email_verified: 1, role: 'user' })

    const session = await h.call('/get-session', { cookie })
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
      'visitor@example.com'
    )

    const signedOut = await h.call('/sign-out', { body: {}, cookie })
    expect(signedOut.status).toBe(200)
    expect(await (await h.call('/get-session', { cookie })).json()).toBeNull()
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })

  it('caps guesses per code and rejects reuse', async () => {
    const h = harness()
    const email = 'guesser@example.com'
    const otp = await requestCode(h, email)
    const wrong = otp === '000000' ? '111111' : '000000'
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await h.call('/sign-in/email-otp', { body: { email, otp: wrong } })
      expect(response.status, `attempt ${attempt}`).toBe(400)
    }
    const locked = await h.call('/sign-in/email-otp', { body: { email, otp } })
    expect(locked.status).toBe(403)
    expect(((await locked.json()) as { code: string }).code).toBe('TOO_MANY_ATTEMPTS')
    // The code is gone; even the right one no longer works.
    expect((await h.call('/sign-in/email-otp', { body: { email, otp } })).status).toBe(400)
  })

  it('limits code requests per email and per IP in D1', async () => {
    const h = harness()
    await requestCode(h, 'limited@example.com', '198.51.100.1')
    const again = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'LIMITED@example.com', type: 'sign-in' },
      ip: '198.51.100.2'
    })
    expect(again.status).toBe(429)
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await again.json()) as { code: string }).code).toBe('RATE_LIMITED')

    // One IP may request a few codes per minute for different emails, then waits.
    const ip = '198.51.100.3'
    for (let index = 0; index < OTP_REQUEST_LIMITS.ipBurst.max; index += 1) {
      await requestCode(h, `person-${index}@example.com`, ip)
    }
    const burst = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'one-more@example.com', type: 'sign-in' },
      ip
    })
    expect(burst.status).toBe(429)
    const rows = h.sqlite.database.prepare('SELECT count(*) AS n FROM auth_rate_limit_hits').get()
    expect(Number((rows as { n: number }).n)).toBeGreaterThan(0)
  })

  it('groups an IPv6 /64 into one client for the per-IP limits', async () => {
    const h = harness()
    for (let index = 1; index <= OTP_REQUEST_LIMITS.ipBurst.max; index += 1) {
      await requestCode(h, `v6-${index}@example.com`, `2001:db8:77:77::${index}`)
    }
    const sameSubnet = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'v6-more@example.com', type: 'sign-in' },
      ip: '2001:db8:77:77:ffff::1'
    })
    expect(sameSubnet.status).toBe(429)
    await requestCode(h, 'v6-other@example.com', '2001:db8:77:78::1')
  })

  // Review round 2, finding 1: an attacker cannot stop a legitimate user from getting a code.
  it('cannot lock out an owner with a known device from 20 /64s', async () => {
    const h = harness()
    const owner = 'devin@serp.co'
    const { device } = await signInWithDevice(h, owner, '2001:db8:aa:1::1')

    // One request each from 20 /64s spends the owner's email-wide ceiling.
    let accepted = 0
    for (let subnet = 1; subnet <= 20; subnet += 1) {
      const response = await h.call('/email-otp/send-verification-otp', {
        body: { email: owner, type: 'sign-in' },
        ip: `2001:db8:bad:${subnet.toString(16)}::1`
      })
      if (response.status === 200) accepted += 1
    }
    expect(accepted).toBeGreaterThanOrEqual(OTP_REQUEST_LIMITS.memberEmailHourly.max - 1)
    const flooded = await h.call('/email-otp/send-verification-otp', {
      body: { email: owner, type: 'sign-in' },
      ip: '2001:db8:bad:ff::1'
    })
    expect(flooded.status).toBe(429)

    // Without the cookie the inbox ceiling holds, from any address...
    const stranger = await h.call('/email-otp/send-verification-otp', {
      body: { email: owner, type: 'sign-in' },
      ip: '2001:db8:cafe:1::1'
    })
    expect(stranger.status).toBe(429)
    // ...but the owner's own browser still gets a code, from a new address too.
    for (const ip of ['2001:db8:aa:1::1', '2001:db8:cafe:2::1']) {
      const own = await h.call('/email-otp/send-verification-otp', {
        body: { email: owner, type: 'sign-in' },
        cookie: device,
        ip
      })
      expect(own.status, ip).toBe(200)
    }
    // Another account's device cookie does not help.
    const { device: otherDevice } = await signInWithDevice(h, 'other@example.com', '192.0.2.40')
    const borrowed = await h.call('/email-otp/send-verification-otp', {
      body: { email: owner, type: 'sign-in' },
      cookie: otherDevice,
      ip: '2001:db8:cafe:3::1'
    })
    expect(borrowed.status).toBe(429)
  })

  it('cannot block an existing user with 300 requests for new emails', async () => {
    const h = harness()
    const { device } = await signInWithDevice(h, 'member@example.com', '192.0.2.50')

    // 60 /64s x 5 requests for fresh addresses fill the site-wide ceiling (the member's own
    // first sign-in, a new email then, used one slot).
    let accepted = 0
    for (let subnet = 1; subnet <= 60; subnet += 1) {
      for (let request = 1; request <= 5; request += 1) {
        const response = await h.call('/email-otp/send-verification-otp', {
          body: { email: `flood-${subnet}-${request}@example.com`, type: 'sign-in' },
          ip: `2001:db8:f00d:${subnet.toString(16)}::${request}`
        })
        if (response.status === 200) accepted += 1
      }
    }
    expect(accepted).toBe(OTP_REQUEST_LIMITS.siteHourly.max - 1)
    const newcomer = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'newcomer@example.com', type: 'sign-in' },
      ip: '192.0.2.60'
    })
    expect(newcomer.status).toBe(429)

    // Existing accounts are outside the site-wide ceiling, with or without their device.
    const withDevice = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'member@example.com', type: 'sign-in' },
      cookie: device,
      ip: '192.0.2.61'
    })
    expect(withDevice.status).toBe(200)
    const elsewhere = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'member@example.com', type: 'sign-in' },
      ip: '192.0.2.62'
    })
    expect(elsewhere.status).toBe(200)
  })

  it('sets the known-device cookie after a sign-in, scoped to /api/auth', async () => {
    const h = harness()
    const email = 'device@example.com'
    const otp = await requestCode(h, email)
    const response = await h.call('/sign-in/email-otp', { body: { email, otp } })
    expect(response.status).toBe(200)
    const header = response.headers
      .getSetCookie()
      .find(value => value.startsWith('bsc_known_device='))
    expect(header).toBeDefined()
    expect(header).toContain('Path=/api/auth')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain(`Max-Age=${180 * 24 * 60 * 60}`)
    // A failed sign-in sets nothing.
    const failed = await h.call('/sign-in/email-otp', { body: { email, otp: '000000' } })
    expect(failed.headers.getSetCookie().some(value => value.includes('bsc_known_device'))).toBe(
      false
    )
  })

  it('serves only the allowlisted endpoints; every other Better Auth route is 404', async () => {
    const h = harness()
    const allowed = new Set(
      [...ALLOWED_AUTH_ENDPOINTS, ...DEV_AUTH_ENDPOINTS].map(e => `${e.method} ${e.path}`)
    )
    // Every allowlisted endpoint exists, so the list cannot drift from Better Auth.
    const registered = new Set(
      h.auth.routes.flatMap(route => route.methods.map(method => `${method} ${route.path}`))
    )
    for (const endpoint of allowed) expect(registered, endpoint).toContain(endpoint)
    expect(h.auth.routes.length).toBeGreaterThan(20)

    let refused = 0
    for (const route of h.auth.routes) {
      const path = route.path.replace(/:[A-Za-z]+/gu, 'x')
      for (const method of route.methods) {
        if (allowed.has(`${method} ${route.path}`)) continue
        const response = await h.call(path, {
          body: method === 'GET' ? undefined : { email: 'x@example.com', password: 'p4ssword!' },
          method
        })
        expect(response.status, `${method} ${route.path}`).toBe(404)
        refused += 1
      }
    }
    expect(refused).toBeGreaterThan(20)
    for (const path of ['/update-user', '/delete-user', '/verify-password', '/sign-in/social']) {
      expect((await h.call(path, { body: { role: 'admin' } })).status, path).toBe(404)
    }
    // Variants of an allowlisted path are not allowlisted.
    for (const path of ['/get-session/', '/GET-SESSION', '/get-session%2F']) {
      expect((await h.call(path)).status, path).toBe(404)
    }
    expect((await h.call('/sign-out', { method: 'GET' })).status).toBe(404)

    const reset = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'reset@example.com', type: 'forget-password' }
    })
    expect(reset.status).toBe(400)
  })

  it('lets a first sign-in set a short name but never an image', async () => {
    const h = harness()
    const email = 'named@example.com'
    const otp = await requestCode(h, email)
    for (const body of [
      { email, image: 'javascript:alert(1)', otp },
      { email, name: 'x'.repeat(MAX_NAME_LENGTH + 1), otp },
      { email, name: 42, otp }
    ]) {
      const refused = await h.call('/sign-in/email-otp', { body })
      expect(refused.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    const accepted = await h.call('/sign-in/email-otp', { body: { email, name: 'Named', otp } })
    expect(accepted.status).toBe(200)
    expect(
      h.sqlite.database.prepare('SELECT name, image FROM users WHERE email = ?').get(email)
    ).toEqual({ image: null, name: 'Named' })
  })

  it('rejects cross-site requests that carry the session cookie', async () => {
    const h = harness()
    const cookie = await signIn(h, 'csrf@example.com')
    for (const origin of ['https://evil.example', null]) {
      const forged = await h.call('/sign-out', { body: {}, cookie, origin })
      expect(forged.status, String(origin)).toBe(403)
    }
    expect(await (await h.call('/get-session', { cookie })).json()).not.toBeNull()
  })
})

describe('roles from the admin allowlist', () => {
  const guard = (h: Harness, cookie?: string) =>
    authorizeAdmin({
      getAdminStatus: userId => h.operations.getAdminStatus(userId),
      getSession: async () => {
        const result = await h.auth.api.getSession({
          headers: new Headers({ host: new URL(h.origin).host, ...(cookie ? { cookie } : {}) })
        })
        return result
          ? {
              session: result.session,
              user: { ...result.user, role: String(result.user.role ?? '') }
            }
          : null
      }
    })

  it('makes the seeded owner an admin and everyone else a user', async () => {
    const h = harness()
    const ownerCookie = await signIn(h, 'devin@serp.co', '192.0.2.1')
    const visitorCookie = await signIn(h, 'visitor@example.com', '192.0.2.2')
    const roles = h.sqlite.database.prepare('SELECT email, role FROM users ORDER BY email').all()
    expect(roles.map(row => ({ ...row }))).toEqual([
      { email: 'devin@serp.co', role: 'admin' },
      { email: 'visitor@example.com', role: 'user' }
    ])

    expect(await guard(h, ownerCookie)).toMatchObject({ ok: true })
    expect(await guard(h, visitorCookie)).toMatchObject({ status: 403 })
    expect(await guard(h)).toMatchObject({ status: 401 })

    // Removing the owner from the allowlist revokes admin access on the next request.
    h.sqlite.database.prepare('DELETE FROM admin_allowlist').run()
    expect(await guard(h, ownerCookie)).toMatchObject({ status: 403 })
  })

  it('never lets a user choose their own role', async () => {
    const h = harness()
    const email = 'climber@example.com'
    const otp = await requestCode(h, email)
    const signedIn = await h.call('/sign-in/email-otp', { body: { email, otp, role: 'admin' } })
    expect(signedIn.status).toBe(200)
    const cookie = sessionCookie(signedIn)
    const row = h.sqlite.database.prepare('SELECT role FROM users WHERE email = ?').get(email)
    expect(row).toEqual({ role: 'user' })
    // Profile updates are not served at all, so no field (role included) can change later.
    const update = await h.call('/update-user', { body: { role: 'admin' }, cookie })
    expect(update.status).toBe(404)
    expect(h.sqlite.database.prepare('SELECT role FROM users WHERE email = ?').get(email)).toEqual({
      role: 'user'
    })
  })
})

describe('staging and production', () => {
  it('answers 503 for a code until email delivery exists, and exposes no outbox', async () => {
    const h = harness({ environment: 'staging', sender: unavailableOtpSender })
    const response = await h.call('/email-otp/send-verification-otp', {
      body: { email: 'devin@serp.co', type: 'sign-in' }
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('OTP_DELIVERY_UNAVAILABLE')
    expect((await h.call(`${DEV_OTP_OUTBOX_PATH}?email=devin@serp.co`)).status).toBe(404)
  })

  it('uses __Secure- session cookies on https origins', async () => {
    const sent: OtpMessage[] = []
    const h = harness({
      environment: 'staging',
      sender: {
        kind: 'test',
        async send(message) {
          sent.push(message)
        }
      }
    })
    const email = 'staging@example.com'
    const requested = await h.call('/email-otp/send-verification-otp', {
      body: { email, type: 'sign-in' }
    })
    expect(requested.status).toBe(200)
    const otp = sent[0]?.otp
    expect(otp).toMatch(/^\d{6}$/u)
    const response = await h.call('/sign-in/email-otp', { body: { email, otp } })
    expect(response.status).toBe(200)
    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain(`__Secure-${AUTH_COOKIE_PREFIX}.session_token=`)
    expect(setCookie).toMatch(/HttpOnly/iu)
    expect(setCookie).toMatch(/Secure/u)
    expect(setCookie).toMatch(/SameSite=Lax/iu)
    expect(setCookie).toMatch(
      /__Secure-bsc_known_device=[^;]+; Max-Age=\d+; Path=\/api\/auth; HttpOnly; SameSite=Strict; Secure/u
    )
  })

  it('refuses the dev sender outside local', () => {
    const sqlite = new SqliteD1()
    const client = createDatabase(sqlite.asD1Database())
    expect(() =>
      createAuth({
        client,
        operations: createAuthOperations({ client, rateLimitKey: SECRET }),
        sender: createDevOtpSender(() => {}),
        settings: resolveAuthSettings({
          BETTER_AUTH_SECRET: SECRET,
          BETTER_AUTH_URL: STAGING_ORIGIN,
          D1_RUNTIME_ENV: 'staging',
          SITE_ENVIRONMENT: 'staging'
        })
      })
    ).toThrow(/only runs locally/u)
  })
})
