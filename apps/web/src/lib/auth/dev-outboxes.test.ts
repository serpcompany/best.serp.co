/**
 * Both local-only dev outboxes (the sign-in code outbox and the email outbox) answer only on a
 * Worker whose `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` both say `local` (PR #84 review round 1,
 * finding 10). One var alone is never enough.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '@/db/test-support'
import { devEmailOutboxResponse } from '../email/dev-outbox'
import { clearDevEmailOutbox, createLogEmailSender } from '../email/senders'
import { handleAuthRequest } from './server'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const ORIGIN = 'http://localhost:8978'
const SECRET = 'test-secret-'.repeat(4)

function worker(vars: { D1_RUNTIME_ENV: string; SITE_ENVIRONMENT: string }) {
  const env = {
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: vars.SITE_ENVIRONMENT === 'local' ? undefined : 'https://example.workers.dev',
    DB: new SqliteD1().asD1Database(),
    ...vars
  }
  getCloudflareContext.mockResolvedValue({ ctx: { waitUntil: () => {} }, env })
  return env
}

async function otpOutbox(origin = ORIGIN): Promise<Response> {
  return handleAuthRequest(
    new Request(`${origin}/api/auth/dev/otp-outbox?email=a%40example.com`, {
      headers: { origin }
    })
  )
}

afterEach(() => {
  clearDevEmailOutbox()
  vi.restoreAllMocks()
})

describe('dev outboxes', () => {
  it.each([
    { D1_RUNTIME_ENV: 'staging', SITE_ENVIRONMENT: 'local' },
    { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'staging' },
    { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'production' },
    { D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'local' }
  ])('stay closed when only one var says local: %o', async vars => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const env = worker(vars)
    // Accounts refuse mismatched settings, so every auth route (the code outbox too) is 503.
    const codes = await otpOutbox()
    expect(codes.status).toBe(503)
    expect(await codes.text()).not.toMatch(/"otp"/u)
    const emails = devEmailOutboxResponse(env, `${ORIGIN}/api/dev/email-outbox?to=a@example.com`)
    expect(emails.status).toBe(404)
  })

  it('stay closed on a correctly configured staging or production Worker', async () => {
    for (const environment of ['staging', 'production']) {
      const env = worker({ D1_RUNTIME_ENV: environment, SITE_ENVIRONMENT: environment })
      expect((await otpOutbox()).status, environment).toBe(404)
      expect(devEmailOutboxResponse(env, `${ORIGIN}/api/dev/email-outbox`).status).toBe(404)
    }
  })

  // A Worker that runs with the local vars must still serve nothing to a deployed host (#164).
  // Better Auth's allowed hosts for the local config refuse the code outbox first; the email
  // outbox checks the host itself.
  it('stay closed on a local Worker for a request to a non-local host', async () => {
    const env = worker({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' })
    for (const origin of ['https://best.serp.co', 'https://best-serp-co-staging.example.test']) {
      const codes = await otpOutbox(origin).catch((error: unknown) => error)
      if (codes instanceof Response) {
        expect(codes.status, origin).not.toBe(200)
        expect(await codes.text()).not.toMatch(/"otp"/u)
      } else {
        expect(String(codes), origin).toMatch(/not in the allowed hosts list/u)
      }
      const emails = devEmailOutboxResponse(env, `${origin}/api/dev/email-outbox?to=a@example.com`)
      expect(emails.status, origin).toBe(404)
    }
  })

  it('answer on a local Worker', async () => {
    const env = worker({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' })
    expect((await otpOutbox()).status).toBe(200)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await createLogEmailSender(undefined, { devOutbox: true }).send({
      from: { email: 'noreply@mail.serp.co', name: 'SERP Directory' },
      headers: {},
      html: '<p>Hi</p>',
      idempotencyKey: 'k',
      subject: 'Hello',
      text: 'Hi',
      to: 'a@example.com'
    })
    const emails = devEmailOutboxResponse(env, `${ORIGIN}/api/dev/email-outbox?to=A@example.com`)
    expect(emails.status).toBe(200)
    expect(await emails.json()).toMatchObject({
      messages: [{ subject: 'Hello', to: 'a@example.com' }]
    })
  })
})
