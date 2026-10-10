import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startServerSentryFor } from './lib/telemetry/server-errors'

const sentry = vi.hoisted(() => ({
  captureRequestError: vi.fn(),
  startServerSentry: vi.fn()
}))
vi.mock('./lib/telemetry/server-sentry', () => sentry)

const SWITCH = Symbol.for('best.serp.co/server-sentry')

beforeEach(() => {
  sentry.captureRequestError.mockReset()
  sentry.startServerSentry.mockReset()
})

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SWITCH]
  vi.restoreAllMocks()
})

const context = {
  revalidateReason: undefined,
  routePath: '/(site)/products/[slug]',
  routerKind: 'App Router',
  routeType: 'render'
} as const

describe('instrumentation (#48, #355)', () => {
  it('starts Sentry with the first request that reports to it, not before', async () => {
    const { register } = await import('./instrumentation')
    await register()
    expect(sentry.startServerSentry).not.toHaveBeenCalled()
    await startServerSentryFor(new Request('https://best.serp.co/products/fixture-studio/'))
    expect(sentry.startServerSentry).not.toHaveBeenCalled()
    await startServerSentryFor(new Request('https://best.serp.co/admin/'))
    expect(sentry.startServerSentry).toHaveBeenCalledTimes(1)
  })

  it('logs a public page error and never loads Sentry for it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onRequestError } = await import('./instrumentation')
    const error = new Error('render failed')
    await onRequestError(
      error,
      { headers: { cookie: 'session=1' }, method: 'GET', path: '/products/fixture-studio/?x=1' },
      context
    )
    expect(sentry.startServerSentry).not.toHaveBeenCalled()
    expect(sentry.captureRequestError).not.toHaveBeenCalled()
    const line = String(logged.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toMatchObject({
      event: 'request_error',
      message: 'render failed',
      path: '/products/fixture-studio/',
      route: '/(site)/products/[slug]'
    })
    expect(line).not.toContain('session=1')
  })

  it('reports a signed-in or operational surface error to Sentry', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onRequestError } = await import('./instrumentation')
    const error = new Error('webhook failed')
    const request = { headers: {}, method: 'POST', path: '/api/billing/webhook/' }
    const routeContext = {
      ...context,
      routePath: '/api/billing/webhook',
      routeType: 'route'
    } as const
    await onRequestError(error, request, routeContext)
    expect(sentry.startServerSentry).toHaveBeenCalled()
    expect(sentry.captureRequestError).toHaveBeenCalledWith(error, request, routeContext)
    expect(logged).not.toHaveBeenCalled()
  })
})
