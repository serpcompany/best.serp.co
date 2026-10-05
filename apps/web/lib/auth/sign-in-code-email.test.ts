import { describe, expect, it, vi } from 'vitest'

const { emailDeliveryConfigured, enqueueEmail } = vi.hoisted(() => ({
  emailDeliveryConfigured: vi.fn(async () => true),
  enqueueEmail: vi.fn(async () => undefined)
}))

vi.mock('server-only', () => ({}))
vi.mock('../email/server', async () => ({
  emailDeliveryConfigured,
  emailEventKey: (await import('../email/service')).emailEventKey,
  enqueueEmail
}))

describe('the sign-in code email bridge', () => {
  it('is registered, because the sign-in-code template is in the email registry', async () => {
    const { appEmailTemplates } = await import('../email/registry')
    const { signInCodeEmail } = await import('./sign-in-code-email')
    expect(Object.hasOwn(appEmailTemplates, 'sign-in-code')).toBe(true)
    expect(signInCodeEmail.templateRegistered).toBe(true)
  })

  it('keys every code email by a fresh UUID and enqueues it as sign-in-code', async () => {
    const { signInCodeEmail } = await import('./sign-in-code-email')
    const first = signInCodeEmail.eventKey()
    expect(first).toMatch(/^sign-in-code:[0-9a-f-]{36}$/u)
    expect(signInCodeEmail.eventKey()).not.toBe(first)
    const request = {
      eventKey: first,
      input: { code: '482913', expiresInMinutes: 10 },
      to: 'owner@example.com'
    }
    await signInCodeEmail.enqueue(request)
    expect(enqueueEmail).toHaveBeenCalledWith('sign-in-code', request)
  })

  it('asks the email module whether this Worker can deliver before each code', async () => {
    const { signInCodeEmail } = await import('./sign-in-code-email')
    emailDeliveryConfigured.mockResolvedValueOnce(false)
    expect(await signInCodeEmail.deliveryConfigured()).toBe(false)
    expect(await signInCodeEmail.deliveryConfigured()).toBe(true)
    expect(emailDeliveryConfigured).toHaveBeenCalledTimes(2)
  })
})
