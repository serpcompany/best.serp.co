import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SITEMAP_INDEX_PATH, sitemapPaths, siteRoutes } from '../site/site-routes'
import {
  logRequestError,
  registerServerSentryStarter,
  reportsToServerSentry,
  SERVER_SENTRY_SURFACES,
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

  it('reads only the pathname of an absolute URL', () => {
    expect(reportsToServerSentry('https://best.serp.co/admin/listings/?q=1')).toBe(true)
    expect(reportsToServerSentry('https://best.serp.co/api/search/')).toBe(true)
    expect(reportsToServerSentry('https://best.serp.co/products/admin/')).toBe(false)
    expect(reportsToServerSentry('https://best.serp.co/')).toBe(false)
  })
})

/**
 * The top-level route segments that are public pages: their request errors go to the Worker's
 * logs, not Sentry. A new top-level route must join this list or `SERVER_SENTRY_SURFACES`.
 */
const PUBLIC_SEGMENTS = [
  'about',
  'brands',
  'contact',
  'legal',
  'pricing',
  'products',
  'rss.xml',
  'search',
  'sitemap-categories.xml',
  'sitemap-index.xml',
  'sitemap-pages.xml',
  'sitemap-products.xml',
  'sponsor'
]

/** The first URL segment of every route folder in `src/app`, looking through route groups. */
function topLevelRouteSegments(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !/^[_@]/u.test(entry.name))
    .flatMap(entry =>
      /^\(.+\)$/u.test(entry.name)
        ? topLevelRouteSegments(join(directory, entry.name))
        : [entry.name]
    )
}

describe('every top-level route is classified (#355)', () => {
  const segments = [...new Set(topLevelRouteSegments(join(import.meta.dirname, '../../app')))]

  it('as a Sentry surface or a public page, never both', () => {
    for (const segment of segments) {
      const surface = SERVER_SENTRY_SURFACES.includes(segment)
      expect(surface || PUBLIC_SEGMENTS.includes(segment), `classify /${segment}/`).toBe(true)
      expect(surface && PUBLIC_SEGMENTS.includes(segment), `/${segment}/ is in both`).toBe(false)
      expect(reportsToServerSentry(`/${segment}/`), `/${segment}/`).toBe(surface)
    }
  })

  it('with no entry for a route that no longer exists', () => {
    for (const segment of [...SERVER_SENTRY_SURFACES, ...PUBLIC_SEGMENTS])
      expect(segments, segment).toContain(segment)
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

  it('logs an error once when Next.js reports it twice', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('detail read failed')
    const context = { routePath: '/(site)/products/[slug]', routeType: 'render' }
    logRequestError(error, { method: 'GET', path: '/products/fixture-studio/' }, context)
    logRequestError(error, { method: 'GET', path: '/products/fixture-studio/' }, context)
    logRequestError(new Error('detail read failed'), { method: 'GET', path: '/' }, context)
    expect(logged).toHaveBeenCalledTimes(2)
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

/**
 * A static import, re-export, bare import or `require` of any `@sentry/*` package: each one
 * evaluates the SDK with the module that holds it. Comments are dropped first; a dynamic
 * `import()` is allowed.
 */
const STATIC_SENTRY_IMPORT =
  /(?:^|[\s;])(?:import|export)\b[^'"();]*?['"]@sentry\/[^'"]*['"]|\brequire\(\s*['"]@sentry\//mu

function importsSentryStatically(source: string): boolean {
  return STATIC_SENTRY_IMPORT.test(
    source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  )
}

describe('where the Sentry SDK is imported (#355)', () => {
  it('recognizes every static form, and not a dynamic import', () => {
    for (const source of [
      "import * as Sentry from '@sentry/nextjs'",
      "import { init,\n  captureException } from '@sentry/nextjs'",
      "import '@sentry/nextjs'",
      "export { captureException } from '@sentry/nextjs'",
      "export * from '@sentry/core'",
      "import { withSentry } from '@sentry/cloudflare'",
      "const Sentry = require('@sentry/nextjs')"
    ]) {
      expect(importsSentryStatically(source), source).toBe(true)
    }
    for (const source of [
      "const sentry = await import('@sentry/nextjs')",
      "void import('@sentry/nextjs').then(({ captureException }) => captureException(error))",
      "// import * as Sentry from '@sentry/nextjs'",
      "/* export * from '@sentry/nextjs' */",
      "import { z } from 'zod'"
    ]) {
      expect(importsSentryStatically(source), source).toBe(false)
    }
  })

  it('statically only in the browser entry and the gated Worker module', () => {
    const web = join(import.meta.dirname, '../../..')
    const files = [
      'worker.ts',
      ...(readdirSync(join(web, 'src'), { recursive: true }) as string[]).map(file =>
        join('src', file)
      )
    ]
    const importers = files
      .filter(file => /\.(?:[cm]?js|jsx|ts|tsx)$/u.test(file) && !/\.test\.tsx?$/u.test(file))
      .filter(file => importsSentryStatically(readFileSync(join(web, file), 'utf8')))
      .map(file => relative(web, join(web, file)))
      .sort()
    expect(importers).toEqual([
      'src/instrumentation-client.ts',
      'src/lib/telemetry/server-sentry.ts'
    ])
  })
})
