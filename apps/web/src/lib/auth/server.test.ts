/**
 * The admin adapters of `server.ts` through the real wiring (serpcompany/best.serp.co#78):
 * `getAccountRuntime()`, Better Auth sessions from a local sign-in, and `createAuthOperations`
 * over SQLite with the checked-in migrations. `requireAdmin()` and `authorizeAdminRequest()`
 * read the allowlist on every request, so removing an email revokes admin access on the next
 * request, also while another admin stays on the allowlist.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '@/db/test-support'
import { CodedError } from '@/lib/telemetry/coded-error'
import { errorFields } from '@/lib/telemetry/error-fields'
import { ADMIN_PAGE_PATH_HEADER } from './admin-gate'
import { hasSessionCookie } from './cookies'
import { clearDevOtpOutbox } from './otp-sender'
import { authorizeAdminRequest, getSessionAdmin, handleAuthRequest, requireAdmin } from './server'

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
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`)
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

/** `getSessionAdmin()`'s email for this session, or null. */
async function sessionAdmin(cookie: string): Promise<string | null> {
  requestHeaders.current = new Headers({ cookie, host: HOST })
  return (await getSessionAdmin())?.email ?? null
}

async function adminPage(cookie: string, headers: Record<string, string> = {}): Promise<string> {
  requestHeaders.current = new Headers({ ...headers, cookie, host: HOST })
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

  it('sends an admin page without a valid session to sign-in and back; a non-admin keeps 403 (#488)', async () => {
    localWorker()
    const owner = await signIn('devin@serp.co', '192.0.2.14')
    const visitor = await signIn('visitor@example.com', '192.0.2.15')
    const returnPath = '/admin/submissions/sub_1/?tab=media'
    // What the Worker puts on every admin page request (`withAdminPagePath`).
    const page = { [ADMIN_PAGE_PATH_HEADER]: returnPath }
    const signInUrl = `/login/?callbackUrl=${encodeURIComponent(returnPath)}`
    expect(await adminPage('', page)).toBe(`NEXT_REDIRECT ${signInUrl}`)
    expect(await adminPage('better-auth.session_token=stale.value', page)).toBe(
      `NEXT_REDIRECT ${signInUrl}`
    )
    expect(await adminPage(visitor, page)).toBe('NEXT_FORBIDDEN')
    expect(await adminPage(owner, page)).toBe('devin@serp.co')
    // Without the Worker's path (`next dev`), the 401 stays.
    expect(await adminPage('better-auth.session_token=stale.value')).toBe('NEXT_UNAUTHORIZED')
  })

  it('names the session admin for admin links, without throwing for anyone else (#489)', async () => {
    const sqlite = localWorker()
    const owner = await signIn('devin@serp.co', '192.0.2.14')
    const visitor = await signIn('visitor@example.com', '192.0.2.15')

    expect(await sessionAdmin(owner)).toBe('devin@serp.co')
    expect(await sessionAdmin(visitor)).toBeNull()
    expect(await sessionAdmin('')).toBeNull()

    sqlite.database.prepare("DELETE FROM admin_allowlist WHERE email = 'devin@serp.co'").run()
    // The stored `admin` role is unchanged; the live allowlist check decides.
    expect(await sessionAdmin(owner)).toBeNull()
  })

  it('reads the allowlist for admin links only when the session role is admin (#494)', async () => {
    const sqlite = localWorker()
    const owner = await signIn('devin@serp.co', '192.0.2.16')
    const visitor = await signIn('visitor@example.com', '192.0.2.17')
    const allowlistReads = async (cookie: string) => {
      sqlite.statements.length = 0
      await sessionAdmin(cookie)
      return sqlite.statements.filter(statement => statement.sql.includes('"admin_allowlist"'))
    }

    expect(await allowlistReads(visitor)).toEqual([])
    expect(await allowlistReads('')).toEqual([])
    // The same filter sees the read an admin session makes.
    expect(await allowlistReads(owner)).toHaveLength(1)
  })

  it('fails a page closed with a code that names the guard, when D1 cannot answer (#389)', async () => {
    const sqlite = localWorker()
    const owner = await signIn('devin@serp.co', '192.0.2.13')
    sqlite.database.exec('ALTER TABLE admin_allowlist RENAME TO admin_allowlist_unreadable')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    requestHeaders.current = new Headers({ cookie: owner, host: HOST })
    const failure = await requireAdmin().then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(CodedError)
    expect(errorFields(failure)).toEqual({ code: 'auth_guard_failed', name: 'Error' })
    // The cause is on the guard's own line.
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      event: 'auth_guard_error',
      reason: 'admin_status'
    })
    logged.mockRestore()
  })
})
