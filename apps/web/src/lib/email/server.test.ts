import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../../packages/data-ops/src/test-support'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))

// An untyped view, so tests can also pass ids that are not registered.
async function enqueue(templateId: string, request: unknown): Promise<unknown> {
  const { enqueueEmail } = await import('./server')
  return (enqueueEmail as (id: string, request: unknown) => Promise<unknown>)(templateId, request)
}

function loggedLines(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
}

describe('enqueueEmail', () => {
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    getCloudflareContext.mockReset()
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves and logs a redacted line when the Cloudflare context is unavailable', async () => {
    getCloudflareContext.mockRejectedValue(
      new Error('no context while emailing person@example.com')
    )
    await expect(
      enqueue('test-fixture', { eventKey: 'otp:person@example.com', input: {}, to: 'a@b.co' })
    ).resolves.toBeUndefined()
    expect(loggedLines(errors)).toEqual([
      {
        error: 'no context while emailing [redacted]',
        event: 'email_context_unavailable',
        eventKey: '[invalid]',
        templateId: 'test-fixture'
      }
    ])
  })

  it("schedules delivery on the request's waitUntil and never rejects", async () => {
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
    getCloudflareContext.mockResolvedValue({
      ctx: { waitUntil },
      env: { D1_RUNTIME_ENV: 'local', DB: new SqliteD1().asD1Database(), SITE_ENVIRONMENT: 'local' }
    })
    const infos = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await expect(
      enqueue('sign-in-code', {
        eventKey: 'sign-in-code:0b7c2d9e-1f4a-4c3b-9a8e-123456789abc',
        input: { code: '481902', expiresInMinutes: 10 },
        to: 'owner@serp.co'
      })
    ).resolves.toBeUndefined()
    expect(getCloudflareContext).toHaveBeenCalledWith({ async: true })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    // Locally the registered sign-in code is written to the log, never sent.
    const lines = loggedLines(infos)
    expect(lines[0]).toMatchObject({
      event: 'email_logged',
      subject: '481902 is your SERP sign-in code',
      to: 'owner@serp.co'
    })
    expect(lines[1]).toMatchObject({
      event: 'email_sent',
      provider: 'log',
      templateId: 'sign-in-code'
    })
    expect(loggedLines(errors)).toEqual([])

    // An unregistered id is rejected in the background, never thrown.
    await enqueue('test-fixture', { eventKey: 'fixture:server', input: {}, to: 'owner@serp.co' })
    await waitUntil.mock.calls[1]?.[0]
    expect(loggedLines(errors)).toEqual([
      expect.objectContaining({ event: 'email_rejected', reason: 'unknown_template' })
    ])
  })

  it("reports whether this request's Worker can deliver, false on any doubt", async () => {
    const { emailDeliveryConfigured } = await import('./server')
    const DB = new SqliteD1().asD1Database()
    const deployed = {
      D1_RUNTIME_ENV: 'staging',
      DB,
      SITE_ENVIRONMENT: 'staging',
      USESEND_API_KEY: 'us_test_key',
      USESEND_BASE_URL: 'https://app.usesend.com'
    }
    const cases: Array<[unknown, boolean]> = [
      [deployed, true],
      [{ ...deployed, USESEND_API_KEY: undefined }, false],
      [{ ...deployed, USESEND_BASE_URL: 'https://example.com' }, false],
      [{ ...deployed, DB: undefined }, false],
      [{}, false]
    ]
    for (const [env, expected] of cases) {
      getCloudflareContext.mockResolvedValueOnce({ ctx: { waitUntil: vi.fn() }, env })
      expect(await emailDeliveryConfigured()).toBe(expected)
    }
    getCloudflareContext.mockRejectedValueOnce(new Error('no context'))
    expect(await emailDeliveryConfigured()).toBe(false)
    expect(loggedLines(errors)).toEqual([])
  })

  it('fails closed with a logged line when the environment is not configured', async () => {
    const waitUntil = vi.fn()
    getCloudflareContext.mockResolvedValue({ ctx: { waitUntil }, env: {} })
    await expect(
      enqueue('test-fixture', { eventKey: 'fixture:server', input: {}, to: 'owner@serp.co' })
    ).resolves.toBeUndefined()
    expect(waitUntil).not.toHaveBeenCalled()
    expect(loggedLines(errors)).toEqual([
      expect.objectContaining({ event: 'email_disabled', eventKey: 'fixture:server' })
    ])
  })
})
