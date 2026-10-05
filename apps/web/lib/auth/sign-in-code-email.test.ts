import { afterEach, describe, expect, it, vi } from 'vitest'

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

const request = {
  eventKey: 'sign-in-code:00000000-0000-4000-8000-000000000001',
  input: { code: '482913', expiresInMinutes: 10 },
  to: 'owner@example.com'
}

/** Collects the tasks handed to `waitUntil`, so a test can settle them after the response. */
function afterResponse() {
  const tasks: Promise<unknown>[] = []
  return {
    run: async (task: Promise<unknown>) => {
      tasks.push(task)
    },
    settle: () => Promise.all(tasks),
    tasks
  }
}

async function bridge(
  options: Partial<import('./sign-in-code-email').SignInCodeEmailOptions> = {}
) {
  const { createSignInCodeEmail } = await import('./sign-in-code-email')
  return createSignInCodeEmail({
    afterResponse: afterResponse().run,
    pruneStale: async () => 0,
    ...options
  })
}

afterEach(() => {
  enqueueEmail.mockClear()
  emailDeliveryConfigured.mockClear()
  vi.restoreAllMocks()
})

describe('the sign-in code email bridge', () => {
  it('is registered, because the sign-in-code template is in the email registry', async () => {
    const { appEmailTemplates } = await import('../email/registry')
    expect(Object.hasOwn(appEmailTemplates, 'sign-in-code')).toBe(true)
    expect((await bridge()).templateRegistered).toBe(true)
  })

  it('keys every code email by a fresh UUID and enqueues it as sign-in-code', async () => {
    const email = await bridge()
    const first = email.eventKey()
    expect(first).toMatch(/^sign-in-code:[0-9a-f-]{36}$/u)
    expect(email.eventKey()).not.toBe(first)
    await email.enqueue(request)
    expect(enqueueEmail).toHaveBeenCalledWith('sign-in-code', request)
  })

  it('asks the email module whether this Worker can deliver before each code', async () => {
    const email = await bridge()
    emailDeliveryConfigured.mockResolvedValueOnce(false)
    expect(await email.deliveryConfigured()).toBe(false)
    expect(await email.deliveryConfigured()).toBe(true)
    expect(emailDeliveryConfigured).toHaveBeenCalledTimes(2)
  })

  it('prunes sign-in-code rows older than 24 hours after the response, not before it', async () => {
    const { SIGN_IN_CODE_PRUNE_BATCH } = await import('./sign-in-code-email')
    let release: (rows: number) => void = () => undefined
    const pruneStale = vi.fn(
      () =>
        new Promise<number>(resolve => {
          release = resolve
        })
    )
    const background = afterResponse()
    const email = await bridge({
      afterResponse: background.run,
      clock: () => new Date('2026-10-06T12:00:00.000Z'),
      pruneStale
    })
    // The send resolves while the deletion is still running: it is handed to waitUntil.
    await email.enqueue(request)
    expect(pruneStale).toHaveBeenCalledWith({
      before: new Date('2026-10-05T12:00:00.000Z'),
      limit: SIGN_IN_CODE_PRUNE_BATCH
    })
    expect(background.tasks).toHaveLength(1)
    release(3)
    await background.settle()
  })

  it('never fails a code request because pruning failed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const background = afterResponse()
    const email = await bridge({
      afterResponse: background.run,
      pruneStale: async () => {
        throw new Error('D1_ERROR: database is locked')
      }
    })
    await expect(email.enqueue(request)).resolves.toBeUndefined()
    await background.settle()
    expect(enqueueEmail).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      event: 'sign_in_code_prune_failed',
      message: 'D1_ERROR: database is locked'
    })
  })

  it('logs instead of failing when there is no request context to wait on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const email = await bridge({
      afterResponse: async () => {
        throw new Error('no Cloudflare context')
      }
    })
    await expect(email.enqueue(request)).resolves.toBeUndefined()
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toMatchObject({
      event: 'sign_in_code_prune_failed',
      message: 'no Cloudflare context'
    })
  })
})
