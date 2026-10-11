import * as Sentry from '@sentry/nextjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDACTED_MESSAGE, type SentryBuild, sentryOptions } from './sentry'

/**
 * What the Worker entry's client sends (#210): the SDK builds each event, `sentryOptions`'s
 * `beforeSend` scrubs it, and the client's own transport posts it, to a stubbed `fetch` here.
 */
const PRIVATE = 'private-term-8813'
const BUILD: SentryBuild = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  dsn: 'https://public@o1.ingest.sentry.io/2'
}

interface SentEvent {
  environment?: string
  exception?: {
    values: Array<{
      mechanism?: { handled?: boolean; type?: string }
      stacktrace?: { frames?: unknown[] }
      type?: string
      value?: string
    }>
  }
  platform?: string
  release?: string
  request?: { method?: string; url?: string }
  transaction?: string
  user?: unknown
}

const posts: Array<{ body: string; url: string }> = []

beforeEach(() => {
  vi.resetModules()
  posts.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string | Uint8Array }) => {
      posts.push({
        body: typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body),
        url
      })
      return new Response('{}')
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The events in the envelopes posted so far. */
function sentEvents(): SentEvent[] {
  return posts.flatMap(({ body }) => {
    const lines = body.split('\n')
    const events: SentEvent[] = []
    for (let index = 1; index + 1 < lines.length; index += 2) {
      if (JSON.parse(lines[index] ?? '{}').type === 'event')
        events.push(JSON.parse(lines[index + 1] ?? '{}'))
    }
    return events
  })
}

/** Drizzle puts the failed statement's bound values in its message; D1 adds a cause. */
function drizzleError(): Error {
  return new Error(`Failed query: select * from users where email = ?\nparams: ${PRIVATE}`, {
    cause: new Error(`D1_ERROR: no such table: users: SQLITE_ERROR (${PRIVATE})`)
  })
}

async function report(...args: Parameters<typeof import('./worker-sentry').reportWorkerErrors>) {
  const { reportWorkerErrors } = await import('./worker-sentry')
  await reportWorkerErrors(...args)
}

describe('the Worker entry’s Sentry events (#210)', () => {
  it('sends an escaped request error once, scrubbed, with the environment and release', async () => {
    await report(
      [
        {
          error: drizzleError(),
          mechanism: 'cloudflare.fetch',
          request: { method: 'GET', url: `https://best.serp.co/admin/listings/?q=${PRIVATE}` },
          transaction: 'GET /admin/listings/'
        }
      ],
      { build: BUILD, environment: 'staging' }
    )

    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toMatch(/^https:\/\/o1\.ingest\.sentry\.io\/api\/2\/envelope\/\?/u)
    const [event, ...others] = sentEvents()
    expect(others).toHaveLength(0)
    expect(event).toMatchObject({
      environment: 'staging',
      platform: 'javascript',
      release: `best-serp-co@${BUILD.commit}`,
      request: { method: 'GET', url: 'https://best.serp.co/admin/listings/' },
      transaction: 'GET /admin/listings/'
    })
    expect(event?.user).toBeUndefined()
    // The error and its cause, each with its type and frames, never their messages (#211).
    const exceptions = event?.exception?.values ?? []
    expect(exceptions.map(exception => exception.value)).toEqual([
      REDACTED_MESSAGE,
      REDACTED_MESSAGE
    ])
    expect(exceptions.at(-1)?.mechanism).toMatchObject({ handled: false, type: 'cloudflare.fetch' })
    expect(exceptions[0]?.mechanism).toMatchObject({ source: 'cause', type: 'chained' })
    expect(exceptions.at(-1)?.stacktrace?.frames?.length).toBeGreaterThan(0)
    expect(posts[0]?.body).not.toContain(PRIVATE)
  })

  it('sends one event per failed cron job', async () => {
    await report(
      [
        {
          error: drizzleError(),
          mechanism: 'cloudflare.scheduled',
          transaction: 'draft-reminders-and-expiry (cron 0 * * * *)'
        },
        {
          error: new TypeError(`badge check for ${PRIVATE} failed`),
          mechanism: 'cloudflare.scheduled',
          transaction: 'badge-program (cron 0 * * * *)'
        }
      ],
      { build: BUILD, environment: 'production' }
    )

    const events = sentEvents()
    expect(events.map(event => [event.transaction, event.environment])).toEqual([
      ['draft-reminders-and-expiry (cron 0 * * * *)', 'production'],
      ['badge-program (cron 0 * * * *)', 'production']
    ])
    expect(events[1]?.exception?.values.at(-1)).toMatchObject({
      mechanism: { handled: false, type: 'cloudflare.scheduled' },
      type: 'TypeError',
      value: REDACTED_MESSAGE
    })
    expect(posts.map(post => post.body).join('\n')).not.toContain(PRIVATE)
  })

  it('skips an error the Next.js server SDK already reported, so it is never sent twice', async () => {
    // The Next.js side, as `onRequestError` reports from a signed-in surface: its own client.
    const nextClient = new Sentry.NodeClient({
      ...sentryOptions(() => 'staging', BUILD),
      integrations: [],
      stackParser: Sentry.defaultStackParser,
      transport: transportOptions => Sentry.createTransport(transportOptions, async () => ({}))
    })
    Sentry.setCurrentClient(nextClient)
    nextClient.init()
    const error = drizzleError()
    Sentry.captureRequestError(
      error,
      { headers: {}, method: 'GET', path: '/admin/listings/' },
      { routePath: '/admin/listings', routeType: 'render', routerKind: 'App Router' }
    )
    await nextClient.flush(1000)
    // The SDK marks the error object itself, which every copy of the SDK reads: the Worker
    // entry's bundle has its own.
    expect(Object.getOwnPropertyDescriptor(error, '__sentry_captured__')?.value).toBe(true)

    // Should it escape OpenNext to the Worker entry, which reports with its own client:
    await report(
      [
        {
          error,
          mechanism: 'cloudflare.fetch',
          request: { method: 'GET', url: 'https://best.serp.co/admin/listings/' },
          transaction: 'GET /admin/listings/'
        },
        { error: new Error('a new one'), mechanism: 'cloudflare.fetch', transaction: 'GET /admin/' }
      ],
      { build: BUILD, environment: 'staging' }
    )

    expect(sentEvents().map(event => event.transaction)).toEqual(['GET /admin/'])
    await nextClient.close()
  })

  it('sends nothing without a DSN', async () => {
    await report(
      [{ error: new Error('x'), mechanism: 'cloudflare.scheduled', transaction: 'listing-media' }],
      { build: { commit: BUILD.commit }, environment: 'local' }
    )
    expect(posts).toHaveLength(0)
  })
})
