/**
 * The admin adapters of `server.ts` through the real wiring (serpcompany/best.serp.co#78):
 * `getAccountRuntime()`, Better Auth sessions from a local sign-in, and `createAuthOperations`
 * over SQLite with the checked-in migrations. `requireAdmin()` and `authorizeAdminRequest()`
 * read the allowlist on every request, so removing an email revokes admin access on the next
 * request, also while another admin stays on the allowlist.
 */
import { SqliteD1 } from '@serpdirectory/data-ops/test-support'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasSessionCookie } from './cookies'
import { clearDevOtpOutbox } from './otp-sender'
import { authorizeAdminRequest, handleAuthRequest, requireAdmin } from './server'

const { getCloudflareContext, requestHeaders } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  requestHeaders: { current: new Headers() }
}))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }))
vi.mock('next/navigation', () => ({
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN')
  },
  unauthorized: () => {
    throw new Error('NEXT_UNAUTHORIZED')
  }
}))

const ORIGIN = 'http://localhost:8978'
const HOST = new URL(ORIGIN).host
const SECRET = 'test-secret-'.repeat(4)

function localWorker(): SqliteD1 {
  const sqlite = new SqliteD1()
  getCloudflareContext.mockResolvedValue({
    ctx: { waitUntil: () => {} },
    env: {
      BETTER_AUTH_SECRET: SECRET,
      D1_RUNTIME_ENV: 'local',
      DB: sqlite.asD1Database(),
      SITE_ENVIRONMENT: 'local'
    }
  })
  return sqlite
}

/** Signs in through `/api/auth` with the local dev sender; returns the request cookie header. */
async function signIn(email: string, ip: string): Promise<string> {
  const jar = new Map<string, string>()
  const call = async (path: string, body?: unknown) => {
    const headers = new Headers({ 'cf-connecting-ip': ip, origin: ORIGIN })
    if (jar.size)
      headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
    if (body !== undefined) headers.set('content-type', 'application/json')
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/api/auth${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method: body === undefined ? 'GET' : 'POST'
      })
    )
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (value) jar.set(name, value)
      else jar.delete(name)
    }
    return response
  }
  const sent = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' })
  expect(sent.status, await sent.clone().text()).toBe(200)
  const { otp } = (await (
    await call(`/dev/otp-outbox?email=${encodeURIComponent(email)}`)
  ).json()) as {
    otp: string
  }
  const signedIn = await call('/sign-in/email-otp', { email, otp })
  expect(signedIn.status, await signedIn.clone().text()).toBe(200)
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  expect(hasSessionCookie(cookie)).toBe(true)
  return cookie
}

function adminApiRequest(cookie: string): Request {
  return new Request(`${ORIGIN}/api/admin/listings`, { headers: { cookie, host: HOST } })
}

async function adminPage(cookie: string): Promise<string> {
  requestHeaders.current = new Headers({ cookie, host: HOST })
  try {
    return (await requireAdmin()).email
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

beforeEach(() => clearDevOtpOutbox())

describe('admin adapters re-check the allowlist on every request', () => {
  it('revokes a removed admin on the next request while another admin stays', async () => {
    const sqlite = localWorker()
    sqlite.database
      .prepare(
        "INSERT INTO admin_allowlist (email, added_by) VALUES ('second@example.com', 'test')"
      )
      .run()
    const owner = await signIn('devin@serp.co', '192.0.2.10')
    const second = await signIn('second@example.com', '192.0.2.11')
    const visitor = await signIn('visitor@example.com', '192.0.2.12')

    expect(await authorizeAdminRequest(adminApiRequest(owner))).toMatchObject({ ok: true })
    expect(await authorizeAdminRequest(adminApiRequest(second))).toMatchObject({ ok: true })
    expect(await authorizeAdminRequest(adminApiRequest(visitor))).toMatchObject({
      reason: 'admin_required',
      status: 403
    })
    expect(await adminPage(owner)).toBe('devin@serp.co')
    expect(await adminPage(visitor)).toBe('NEXT_FORBIDDEN')

    sqlite.database.prepare("DELETE FROM admin_allowlist WHERE email = 'devin@serp.co'").run()

    // The owner's session and stored `admin` role are unchanged; only the live check decides.
    expect(await authorizeAdminRequest(adminApiRequest(owner))).toMatchObject({
      reason: 'admin_required',
      status: 403
    })
    expect(await adminPage(owner)).toBe('NEXT_FORBIDDEN')
    expect(await authorizeAdminRequest(adminApiRequest(second))).toMatchObject({ ok: true })
    expect(await adminPage(second)).toBe('second@example.com')
    expect(await adminPage('')).toBe('NEXT_UNAUTHORIZED')
  })
})
