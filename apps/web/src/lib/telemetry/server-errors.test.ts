import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SITEMAP_INDEX_PATH, sitemapPaths, siteRoutes } from '../site/site-routes'
import {
  logRequestError,
  registerServerSentryStarter,
  reportsToServerSentry,
  startServerSentryFor
} from './server-errors'

const SWITCH = Symbol.for('best.serp.co/server-sentry')

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SWITCH]
  vi.restoreAllMocks()
})

const request = (path: string) => new Request(`https://best.serp.co${path}`)

describe('which requests report to the Worker Sentry SDK (#355)', () => {
  it('keeps it for the signed-in and operational surfaces', () => {
    for (const path of [
      '/admin/',
      '/admin/listings/fixture-studio/',
      '/account/',
      '/account/listings/fixture-studio/checkout/',
      '/submit/',
      '/submit/0f0c/choose/',
      '/login/',
      '/claims/0f0c/checkout/success/',
      '/api/search/?q=private',
      '/api/auth/sign-in/email-otp',
      '/api/billing/webhook/',
      '/api/admin/listings/1/approve/'
    ]) {
      expect(reportsToServerSentry(path), path).toBe(true)
    }
  })

  it('drops it for every public page in the route registry but /submit/', () => {
    const publicPaths = siteRoutes
      .map(route => route.path.replace('[slug]', 'fixture-studio').replace('[category]', 'tools'))
      .filter(path => path !== '/submit/')
    for (const path of publicPaths) expect(reportsToServerSentry(path), path).toBe(false)
  })

  it('drops it for the feeds, files and unknown paths', () => {
    for (const path of [
      ...Object.values(sitemapPaths),
      SITEMAP_INDEX_PATH,
      '/rss.xml',
      '/robots.txt',
      '/opengraph-image.png',
      '/products/?page=2',
      '/no-such-page/',
      // Only whole segments count.
      '/administrator/',
      '/apis/',
      '/submitted/'
    ]) {
      expect(reportsToServerSentry(path), path).toBe(false)
    }
  })
})

describe('starting the Worker Sentry SDK (#355)', () => {
  it('starts it once, before the first reporting request renders', async () => {
    const start = vi.fn(async () => {})
    await registerServerSentryStarter(start)
    expect(start).not.toHaveBeenCalled()

    await startServerSentryFor(request('/products/fixture-studio/'))
    expect(start).not.toHaveBeenCalled()

    await startServerSentryFor(request('/admin/'))
    await startServerSentryFor(request('/api/search/'))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('starts it in register() when the reporting request came first', async () => {
    await startServerSentryFor(request('/account/'))
    const start = vi.fn(async () => {})
    await registerServerSentryStarter(start)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('never starts it for an isolate that serves only public pages', async () => {
    await startServerSentryFor(request('/'))
    const start = vi.fn(async () => {})
    await registerServerSentryStarter(start)
    await startServerSentryFor(request('/products/categories/tools/'))
    expect(start).not.toHaveBeenCalled()
  })

  it('logs a failure to start instead of failing the request', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const start = vi.fn(async () => {
      throw new Error('chunk failed')
    })
    await registerServerSentryStarter(start)
    await expect(startServerSentryFor(request('/admin/'))).resolves.toBeUndefined()
    await expect(startServerSentryFor(request('/admin/'))).resolves.toBeUndefined()
    expect(start).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({
      event: 'server_sentry_start_failed',
      message: 'chunk failed'
    })
  })
})

describe('a public page error in the Worker logs (#355)', () => {
  it('is one JSON line with the route and the error, without the query string', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = Object.assign(new Error('D1 unavailable'), { digest: '2817' })
    logRequestError(
      error,
      { method: 'GET', path: '/search/?q=private' },
      {
        renderSource: 'react-server-components',
        revalidateReason: undefined,
        routePath: '/(site)/search',
        routeType: 'render'
      }
    )
    expect(logged).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(logged.mock.calls[0]?.[0]))
    expect(line).toMatchObject({
      digest: '2817',
      event: 'request_error',
      message: 'D1 unavailable',
      method: 'GET',
      name: 'Error',
      path: '/search/',
      renderSource: 'react-server-components',
      route: '/(site)/search',
      routeType: 'render'
    })
    expect(line.stack).toContain('D1 unavailable')
    expect(String(logged.mock.calls[0]?.[0])).not.toContain('private')
  })

  it('logs a thrown non-error as its message', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    logRequestError('boom', { method: 'GET', path: '/' }, { routePath: '/', routeType: 'render' })
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      message: 'boom',
      path: '/'
    })
  })
})

describe('where the Sentry SDK is imported (#355)', () => {
  it('statically only in the browser entry and the gated Worker module', () => {
    const source = join(import.meta.dirname, '../..')
    const importers = (readdirSync(source, { recursive: true }) as string[])
      .filter(file => /\.(ts|tsx)$/u.test(file) && !/\.test\.tsx?$/u.test(file))
      .filter(file =>
        /^\s*import[^(]*from\s+['"]@sentry\/nextjs['"]|require\(\s*['"]@sentry\/nextjs/mu.test(
          readFileSync(join(source, file), 'utf8')
        )
      )
      .map(file => relative(source, join(source, file)))
      .sort()
    expect(importers).toEqual(['instrumentation-client.ts', 'lib/telemetry/server-sentry.ts'])
  })
})
