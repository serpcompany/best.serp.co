import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))

// The registry is empty until the #70 templates land, so calls go through an untyped view.
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
    await expect(
      enqueue('test-fixture', { eventKey: 'fixture:server', input: {}, to: 'owner@serp.co' })
    ).resolves.toBeUndefined()
    expect(getCloudflareContext).toHaveBeenCalledWith({ async: true })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    // No template is registered yet, so the scheduled delivery rejects it and logs why.
    expect(loggedLines(errors)).toEqual([
      expect.objectContaining({
        event: 'email_rejected',
        eventKey: 'fixture:server',
        reason: 'unknown_template'
      })
    ])
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
