import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodedError } from './lib/telemetry/coded-error'
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
      code: 'UNKNOWN',
      event: 'request_error',
      name: 'Error',
      path: '/products/fixture-studio/',
      route: '/(site)/products/[slug]'
    })
    expect(line).not.toContain('session=1')
    expect(line).not.toContain('render failed')
  })

  it('logs a search route error and never loads Sentry for it (#401)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onRequestError } = await import('./instrumentation')
    // What the route throws when D1 drops mid-query: Drizzle puts the statement and its bound
    // values (the visitor's search) in the message.
    const error = new Error('Failed query: select … where name like ?\nparams: %hidden-term%', {
      cause: new Error('D1_ERROR: Network connection lost.')
    })
    const request = { headers: {}, method: 'GET', path: '/api/search?q=hidden-term&limit=100' }
    await onRequestError(error, request, {
      ...context,
      routePath: '/api/search',
      routeType: 'route'
    })
    expect(sentry.startServerSentry).not.toHaveBeenCalled()
    expect(sentry.captureRequestError).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toMatchObject({
      code: 'D1_ERROR:connection_lost',
      event: 'request_error',
      method: 'GET',
      name: 'Error',
      path: '/api/search',
      route: '/api/search',
      routeType: 'route'
    })
    expect(JSON.parse(line).stack).toMatch(/^\s+at /u)
    expect(line).not.toContain('hidden-term')
    expect(line).not.toContain('Failed query')
  })

  it('reports a signed-in or operational surface error to Sentry, and logs it', async () => {
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
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toMatchObject({
      code: 'UNKNOWN',
      event: 'request_error',
      name: 'Error',
      path: '/api/billing/webhook/'
    })
    expect(line).not.toContain('webhook failed')
  })

  it('logs an admin render error with the digest the browser shows, Sentry or not (#204)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onRequestError } = await import('./instrumentation')
    // What `requireAdmin()` throws when D1 can't answer (#389); Next.js sets the digest before
    // it reports the error, and sends the same digest to the browser (React #441).
    const error = Object.assign(new CodedError('auth_guard_failed', 'Accounts are unavailable.'), {
      digest: '2913577842'
    })
    await onRequestError(
      error,
      { headers: {}, method: 'GET', path: '/admin/listings/fixture-studio/?_rsc=1' },
      {
        ...context,
        renderSource: 'react-server-components-payload',
        routePath: '/(dashboard)/admin/listings/[slug]'
      }
    )
    expect(sentry.captureRequestError).toHaveBeenCalledWith(
      error,
      expect.anything(),
      expect.anything()
    )
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toMatchObject({
      code: 'auth_guard_failed',
      digest: '2913577842',
      event: 'request_error',
      name: 'Error',
      path: '/admin/listings/fixture-studio/',
      renderSource: 'react-server-components-payload',
      route: '/(dashboard)/admin/listings/[slug]',
      routeType: 'render'
    })
    expect(line).not.toContain('Accounts are unavailable.')
  })

  it('logs a surface error whose Sentry SDK fails to start', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    sentry.startServerSentry.mockImplementation(() => {
      throw new Error('chunk failed')
    })
    const { onRequestError } = await import('./instrumentation')
    await expect(
      onRequestError(
        new Error('admin render failed'),
        { headers: {}, method: 'GET', path: '/admin/listings/' },
        { ...context, routePath: '/(dashboard)/admin/listings' }
      )
    ).resolves.toBeUndefined()
    expect(sentry.captureRequestError).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      code: 'UNKNOWN',
      event: 'request_error',
      path: '/admin/listings/'
    })
  })
})
