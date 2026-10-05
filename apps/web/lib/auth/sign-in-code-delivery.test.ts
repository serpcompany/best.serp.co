/**
 * A code request on staging through the real wiring (serpcompany/best.serp.co#60, #61): Better
 * Auth's email OTP plugin, `selectOtpSender('staging', signInCodeEmail)`, `enqueueEmail`, the
 * D1 delivery ledger, the `sign-in-code` template, and the useSend sender. `fetch` is a fake, so
 * nothing is ever sent.
 */
import { createAuthOperations } from '@serpdirectory/data-ops/auth'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { SqliteD1 } from '@serpdirectory/data-ops/test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emailSender } from '../email/config'
import { createAuth } from './config'
import { selectOtpSender } from './otp-sender'
import { OTP_EXPIRES_IN_SECONDS, OTP_LENGTH } from './rate-limits'
import { resolveAuthSettings } from './settings'
import { signInCodeEmail } from './sign-in-code-email'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))

const STAGING_ORIGIN = 'https://best-serp-co-staging.serpcompany.workers.dev'
const SECRET = 'test-secret-'.repeat(4)
const FAKE_USESEND_KEY = 'us_fake_key_for_tests'

interface Staging {
  auth: ReturnType<typeof createAuth>
  /** The fake useSend endpoint: every request the email module made. */
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  /** Resolves once every `waitUntil` delivery has finished. */
  settled(): Promise<unknown>
  sqlite: SqliteD1
}

function staging(allowlist: string): Staging {
  const sqlite = new SqliteD1()
  const client = createDatabase(sqlite.asD1Database())
  const settings = resolveAuthSettings({
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_TRUSTED_ORIGINS: STAGING_ORIGIN,
    BETTER_AUTH_URL: STAGING_ORIGIN,
    D1_RUNTIME_ENV: 'staging',
    SITE_ENVIRONMENT: 'staging'
  })
  const pending: Promise<unknown>[] = []
  getCloudflareContext.mockResolvedValue({
    ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    env: {
      D1_RUNTIME_ENV: 'staging',
      DB: sqlite.asD1Database(),
      EMAIL_STAGING_ALLOWLIST: allowlist,
      SITE_ENVIRONMENT: 'staging',
      USESEND_API_KEY: FAKE_USESEND_KEY,
      USESEND_BASE_URL: 'https://app.usesend.com'
    }
  })
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ emailId: 'email_fake_1' }))
  vi.stubGlobal('fetch', fakeFetch)
  return {
    auth: createAuth({
      client,
      operations: createAuthOperations({ client, rateLimitKey: SECRET }),
      sender: selectOtpSender(settings.environment, signInCodeEmail),
      settings
    }),
    fetch: fakeFetch,
    settled: () => Promise.all(pending),
    sqlite
  }
}

function post(path: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({
    'cf-connecting-ip': '203.0.113.40',
    'content-type': 'application/json',
    origin: STAGING_ORIGIN
  })
  if (cookie) headers.set('cookie', cookie)
  return new Request(`${STAGING_ORIGIN}/api/auth${path}`, {
    body: JSON.stringify(body),
    headers,
    method: 'POST'
  })
}

describe('sign-in codes on staging', () => {
  beforeEach(() => {
    getCloudflareContext.mockReset()
    for (const method of ['info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('selects the email sender now that the sign-in-code template is registered', () => {
    expect(signInCodeEmail.templateRegistered).toBe(true)
    expect(selectOtpSender('staging', signInCodeEmail).kind).toBe('email')
    expect(selectOtpSender('production', signInCodeEmail).kind).toBe('email')
  })

  it('enqueues the sign-in-code email, whose code signs the visitor in', async () => {
    const h = staging('devin@serp.co')
    const requested = await h.auth.handler(
      post('/email-otp/send-verification-otp', { email: 'Devin@Serp.co', type: 'sign-in' })
    )
    expect(requested.status).toBe(200)
    await h.settled()

    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = h.fetch.mock.calls[0] ?? []
    expect(url).toBe('https://app.usesend.com/api/v1/emails')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${FAKE_USESEND_KEY}`)
    const sent = JSON.parse(String(init?.body)) as Record<string, string>
    const sender = emailSender('staging')
    expect(sent.from).toBe(`${sender.name} <${sender.email}>`)
    expect(sent.to).toBe('devin@serp.co')
    const code = /^\[staging\] (\d+) is your SERP sign-in code$/u.exec(sent.subject ?? '')?.[1]
    expect(code).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`, 'u'))
    // The email states the lifetime Better Auth enforces, and links to staging.
    expect(sent.text).toContain(`It expires in ${OTP_EXPIRES_IN_SECONDS / 60} minutes`)
    expect(sent.text).toContain(`Enter this code on ${new URL(STAGING_ORIGIN).host} to sign in`)
    expect(sent.html).toContain(`It expires in ${OTP_EXPIRES_IN_SECONDS / 60} minutes`)
    // One key per code, scoped to staging, never derived from the code.
    expect(headers['idempotency-key']).toMatch(
      /^staging:sign-in-code:sign-in-code:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    )
    expect(headers['idempotency-key']).not.toContain(code)
    expect(
      h.sqlite.database.prepare('SELECT template_id, status FROM email_deliveries').all()
    ).toEqual([{ status: 'sent', template_id: 'sign-in-code' }])

    // The emailed code is the code Better Auth stored for this browser.
    const binding = requested.headers
      .getSetCookie()
      .map(header => header.split(';')[0] ?? '')
      .join('; ')
    const signedIn = await h.auth.handler(
      post('/sign-in/email-otp', { email: 'devin@serp.co', otp: code }, binding)
    )
    expect(signedIn.status).toBe(200)
  })

  it('answers the same for an address outside the staging allowlist, and sends nothing', async () => {
    const h = staging('devin@serp.co')
    const requested = await h.auth.handler(
      post('/email-otp/send-verification-otp', { email: 'tester@example.com', type: 'sign-in' })
    )
    expect(requested.status).toBe(200)
    await h.settled()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM email_deliveries').get()).toEqual({
      n: 0
    })
  })
})
