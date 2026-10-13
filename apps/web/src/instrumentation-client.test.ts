import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserSentryOptions } from './lib/telemetry/sentry'

const sentry = vi.hoisted(() => ({ captureRouterTransitionStart: vi.fn(), init: vi.fn() }))
vi.mock('@sentry/nextjs', () => sentry)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the browser entry (#48, #422)', () => {
  it('starts Sentry with the browser settings, so the browser drops its noise', async () => {
    vi.stubGlobal('window', { location: { hostname: 'best.serp.co' } })
    await import('./instrumentation-client')
    expect(sentry.init).toHaveBeenCalledTimes(1)
    const [options] = sentry.init.mock.calls[0] ?? []
    const browser = browserSentryOptions(() => 'production')
    // The shared `sentryOptions` set neither, so a revert to them fails here.
    expect(options).toMatchObject({
      denyUrls: browser.denyUrls,
      environment: 'production',
      ignoreErrors: browser.ignoreErrors
    })
  })
})
