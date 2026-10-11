import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_HOST, STAGING_CANONICAL_HOST } from '../environment/site-environment'
import {
  browserEnvironment,
  ERROR_CODES,
  REDACTED_MESSAGE,
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

  it('takes the DSN and release from the build the Worker entry recorded (#210)', () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '')
    vi.stubEnv('NEXT_PUBLIC_SENTRY_RELEASE', '')
    expect(
      sentryOptions(() => 'production', {
        commit: 'abc1234',
        dsn: 'https://public@o1.ingest.sentry.io/2'
      })
    ).toMatchObject({
      dsn: 'https://public@o1.ingest.sentry.io/2',
      enabled: true,
      release: 'best-serp-co@abc1234'
    })
    expect(sentryOptions(() => 'production', {})).toMatchObject({
      dsn: undefined,
      enabled: false,
      release: undefined
    })
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

  it('redacts every message that is not an allowlisted code (#211)', () => {
    const event = scrubEvent({
      exception: {
        values: [
          // A cause the SDK adds to the chain, then the error itself.
          { type: 'Error', value: 'D1_ERROR: SQLITE_CONSTRAINT (typed@example.com)' },
          { type: 'TypeError', value: 'Failed query: insert into submissions\nparams: My Startup' },
          { type: 'Error', value: '' },
          { type: 'Error' }
        ]
      },
      logentry: { message: 'Search for %s failed', params: ['private search'] },
      message: 'Non-Error promise rejection captured with value: typed@example.com'
    })
    expect(event).toEqual({
      exception: {
        values: [
          { type: 'Error', value: REDACTED_MESSAGE },
          { type: 'TypeError', value: REDACTED_MESSAGE },
          { type: 'Error', value: '' },
          { type: 'Error' }
        ]
      },
      logentry: { message: REDACTED_MESSAGE },
      message: REDACTED_MESSAGE
    })
  })

  it('passes each allowlisted code through unchanged', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(0)
    for (const code of ERROR_CODES) {
      const event = scrubEvent({
        exception: { values: [{ type: 'Error', value: code }] },
        message: code
      })
      expect(event).toEqual({
        exception: { values: [{ type: 'Error', value: code }] },
        message: code
      })
    }
    // Only the exact code: no prefix, suffix or case change.
    const near = scrubEvent({
      exception: {
        values: [{ value: 'search_failed: private search' }, { value: 'SEARCH_FAILED' }]
      }
    })
    expect(near.exception.values).toEqual([
      { value: REDACTED_MESSAGE },
      { value: REDACTED_MESSAGE }
    ])
  })

  it('keeps the allowlist to stable codes', () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })

  it('sends no sessions from the browser or the Worker', () => {
    const { integrations } = sentryOptions(() => 'production')
    const kept = integrations([
      { name: 'BrowserSession' },
      { name: 'ProcessSession' },
      { name: 'GlobalHandlers' }
    ])
    expect(kept.map(integration => integration.name)).toEqual(['GlobalHandlers'])
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
    // Staging's canonical host (#323); both canonical hosts as site-environment.ts names them.
    expect(browserEnvironment('staging.best.serp.co')).toBe('staging')
    expect(browserEnvironment(STAGING_CANONICAL_HOST)).toBe('staging')
    expect(browserEnvironment(CANONICAL_HOST)).toBe('production')
    expect(browserEnvironment('staging.best.serp.co.evil.example')).toBe('local')
    expect(browserEnvironment('127.0.0.1')).toBe('local')
    expect(stripQuery('/a?b#c')).toBe('/a')
  })
})
