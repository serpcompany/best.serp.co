import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserEnvironment,
  scrubEvent,
  sentryOptions,
  sentryRelease,
  stripQuery,
  workerEnvironment
} from './sentry'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Sentry settings (#48)', () => {
  it('stays off without a DSN, so local runs and an unset project send nothing', () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '')
    expect(sentryOptions(() => 'local')).toMatchObject({ dsn: undefined, enabled: false })
  })

  it('turns on with a DSN, with no PII, tracing, or replay', () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/2')
    vi.stubEnv('NEXT_PUBLIC_SENTRY_RELEASE', 'abc1234')
    const options = sentryOptions(() => 'staging')
    expect(options).toMatchObject({
      dsn: 'https://public@o1.ingest.sentry.io/2',
      enabled: true,
      release: 'best-serp-co@abc1234',
      sendDefaultPii: false
    })
    expect(Object.keys(options)).not.toContain('replaysSessionSampleRate')
  })

  it('sets the environment on each event when it is sent', () => {
    let environment: 'local' | 'production' = 'local'
    const options = sentryOptions(() => environment)
    environment = 'production'
    expect(options.beforeSend({}).environment).toBe('production')
  })

  it('removes user data from an event', () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: 'console', message: 'typed@example.com' },
        { category: 'fetch', data: { method: 'POST', status_code: 400, url: '/api/x?token=1' } },
        { category: 'ui.click', data: { target: 'input[name=email]' } }
      ],
      contexts: {
        cloud_resource: {},
        culture: {},
        nextjs: { request_path: '/api/x/?token=secret', route_type: 'route' },
        os: { name: 'Mac' }
      },
      extra: { body: '{"email":"a@b.c"}' },
      request: {
        cookies: 'session=1',
        headers: { cookie: 'session=1' },
        method: 'GET',
        url: 'https://best.serp.co/claims/1/checkout/success/?session_id=cs_live_1#x'
      },
      transaction: 'GET /api/x/?token=secret',
      user: { email: 'a@b.c', ip_address: '203.0.113.1' }
    })
    expect(event).toEqual({
      breadcrumbs: [
        { category: 'fetch', data: { method: 'POST', status_code: 400, url: '/api/x' } },
        { category: 'ui.click', data: undefined }
      ],
      contexts: {
        nextjs: { request_path: '/api/x/', route_type: 'route' },
        os: { name: 'Mac' }
      },
      request: { method: 'GET', url: 'https://best.serp.co/claims/1/checkout/success/' },
      transaction: 'GET /api/x/'
    })
  })

  it('keeps only runtime contexts and SDK tags, so logger data never leaves', () => {
    const event = scrubEvent({
      contexts: {
        browser: { name: 'Chrome' },
        data: { type: 'object', value: { query: 'private search' } },
        trace: { trace_id: 't' }
      },
      tags: { query: 'private search', runtime: 'node', turbopack: true }
    })
    expect(event).toEqual({
      contexts: { browser: { name: 'Chrome' }, trace: { trace_id: 't' } },
      tags: { runtime: 'node', turbopack: true }
    })
  })

  it('strips query strings from stack frames', () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  abs_path: 'app:///products/?q=private&token=secret',
                  filename: 'app:///products/?q=private'
                },
                { filename: 'app:///_next/static/chunks/a.js', function: 'f' }
              ]
            }
          }
        ]
      }
    })
    expect(event.exception.values[0].stacktrace.frames).toEqual([
      { abs_path: 'app:///products/', filename: 'app:///products/' },
      { filename: 'app:///_next/static/chunks/a.js', function: 'f' }
    ])
  })

  it('leaves tracing off and sets the environment at init too', () => {
    const options = sentryOptions(() => 'staging')
    expect(options).not.toHaveProperty('tracesSampleRate')
    expect(options).toMatchObject({ environment: 'staging', tracePropagationTargets: [] })
  })

  it('names the release after a commit only', () => {
    expect(sentryRelease('0123abc')).toBe('best-serp-co@0123abc')
    expect(sentryRelease(undefined)).toBeUndefined()
    expect(sentryRelease('main')).toBeUndefined()
  })

  it('maps the Worker var and the browser host to an environment', () => {
    expect(workerEnvironment('production')).toBe('production')
    expect(workerEnvironment('staging')).toBe('staging')
    expect(workerEnvironment(undefined)).toBe('local')
    expect(browserEnvironment('best.serp.co')).toBe('production')
    expect(browserEnvironment('best-serp-co-staging.serpcompany.workers.dev')).toBe('staging')
    expect(browserEnvironment('127.0.0.1')).toBe('local')
    expect(stripQuery('/a?b#c')).toBe('/a')
  })
})
