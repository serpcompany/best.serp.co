import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ captureRequestError: vi.fn(), init: vi.fn() }))
vi.mock('@sentry/nextjs', () => sdk)

const SWITCH = Symbol.for('best.serp.co/server-sentry')

beforeEach(() => {
  sdk.captureRequestError.mockReset()
  sdk.init.mockReset()
})

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SWITCH]
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('starting the Worker Sentry SDK (#355)', () => {
  it('stays unstarted while init throws, and starts once init succeeds', async () => {
    const { startServerSentry } = await import('./server-sentry')
    sdk.init.mockImplementationOnce(() => {
      throw new Error('integration setup failed')
    })
    expect(() => startServerSentry()).toThrow('integration setup failed')
    startServerSentry()
    startServerSentry()
    expect(sdk.init).toHaveBeenCalledTimes(2)
  })

  it('logs a surface error after a failed start, instead of losing it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    sdk.init.mockImplementation(() => {
      throw new Error('integration setup failed')
    })
    const { onRequestError, register } = await import('../../instrumentation')
    const { startServerSentryFor } = await import('./server-errors')

    await register()
    await startServerSentryFor(new Request('https://best.serp.co/admin/listings/'))
    await onRequestError(
      new Error('admin render failed'),
      { headers: {}, method: 'GET', path: '/admin/listings/' },
      {
        revalidateReason: undefined,
        routePath: '/(dashboard)/admin/listings',
        routerKind: 'App Router',
        routeType: 'render'
      }
    )

    expect(sdk.captureRequestError).not.toHaveBeenCalled()
    expect(logged.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
      { event: 'server_sentry_start_failed', message: 'integration setup failed' },
      expect.objectContaining({
        event: 'request_error',
        message: 'admin render failed',
        path: '/admin/listings/'
      })
    ])
  })
})
