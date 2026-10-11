import * as Sentry from '@sentry/nextjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterAndSortEntries } from '@/components/search/use-search-helpers'
import type { SearchResult } from '@/lib/directory/search-contract'
import { logger } from '@/lib/logging'
import { ERROR_CODES, REDACTED_MESSAGE, sentryOptions } from './sentry'

/**
 * What actually leaves for Sentry (#211): the SDK's own client, with the integrations that ship,
 * builds each event, `beforeSend` (`sentryOptions`, so `scrubEvent`) runs on it, and a transport
 * keeps the envelope instead of sending it. No user input may survive, and an allowlisted code
 * survives unchanged. Each test also checks the event reaching `beforeSend` did carry the input,
 * so a pass means the scrubber removed it.
 */
const PRIVATE = 'private-term-4521'
const envelopes: string[] = []
/** Each event as `beforeSend` received it, before the scrubber. */
const received: SentEvent[] = []

interface SentEvent {
  breadcrumbs?: Array<{ category?: string; data?: unknown; message?: string }>
  exception?: {
    values: Array<{ stacktrace?: { frames?: unknown[] }; type?: string; value?: string }>
  }
  message?: unknown
  request?: { headers?: Record<string, string>; query_string?: unknown }
}

/** The two defaults that install process-wide handlers, which would reach into the test runner. */
const PROCESS_HANDLERS = new Set(['OnUncaughtException', 'OnUnhandledRejection'])

function makeClient() {
  const options = sentryOptions(() => 'production')
  return new Sentry.NodeClient({
    beforeSend(event) {
      received.push(structuredClone(event) as SentEvent)
      return options.beforeSend(event)
    },
    dsn: 'https://public@o1.ingest.sentry.io/2',
    // The SDK's defaults as `sentryOptions` filters them: the request data, console breadcrumbs
    // and linked errors that production runs.
    integrations: options
      .integrations(Sentry.getDefaultIntegrations({}))
      .filter(integration => !PROCESS_HANDLERS.has(integration.name)),
    sendDefaultPii: false,
    stackParser: Sentry.defaultStackParser,
    transport: transportOptions =>
      Sentry.createTransport(transportOptions, async request => {
        envelopes.push(
          typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)
        )
        return {}
      })
  })
}

let client: ReturnType<typeof makeClient>

beforeAll(() => {
  // Quiet, but still instrumented: the SDK wraps this spy, so a console call is a breadcrumb.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  client = makeClient()
  Sentry.setCurrentClient(client)
  client.init()
})

afterAll(async () => {
  await client.close()
  vi.restoreAllMocks()
})

beforeEach(() => {
  envelopes.length = 0
  received.length = 0
  Sentry.getIsolationScope().clearBreadcrumbs()
  Sentry.getCurrentScope().clearBreadcrumbs()
})

/** The events sent since the test began, flushed from the client. */
async function sentEvents(): Promise<SentEvent[]> {
  await client.flush(2000)
  return envelopes.flatMap(
    envelope =>
      envelope
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(item => 'exception' in item || 'message' in item) as unknown as SentEvent[]
  )
}

async function waitForEvents(count: number) {
  await vi.waitFor(async () => {
    expect(await sentEvents()).toHaveLength(count)
  })
  return sentEvents()
}

describe('what reaches Sentry (#211)', () => {
  it('reports a logger call as its code and the caught error’s type, with none of its data', async () => {
    // A real call site: a visitor's search, and an entry that fails to match it.
    const broken = { name: 42, slug: 'broken' } as unknown as SearchResult
    expect(filterAndSortEntries([broken], `${PRIVATE} @ example.com`)).toEqual([])
    logger.error('search_failed', {
      data: { query: PRIVATE },
      extra: { query: PRIVATE },
      tags: { query: PRIVATE }
    })
    const events = await waitForEvents(2)
    // The logger's own console line was a breadcrumb holding the query, before the scrubber.
    expect(
      received.some(event =>
        event.breadcrumbs?.some(
          crumb => crumb.category === 'console' && JSON.stringify(crumb).includes(PRIVATE)
        )
      )
    ).toBe(true)
    const byCode = Object.fromEntries(
      events.map(event => [event.exception?.values.at(-1)?.value, event])
    )
    expect(Object.keys(byCode).sort()).toEqual(['search_failed', 'search_query_match_failed'])
    // The caught error goes as the code's cause: its type and frames, its message redacted.
    expect(byCode.search_query_match_failed?.exception?.values).toEqual([
      expect.objectContaining({ type: 'TypeError', value: REDACTED_MESSAGE }),
      expect.objectContaining({ type: 'Error', value: 'search_query_match_failed' })
    ])
    expect(events.flatMap(event => event.breadcrumbs ?? [])).not.toContainEqual(
      expect.objectContaining({ category: 'console' })
    )
    expect(envelopes.join('\n')).not.toContain(PRIVATE)
  })

  it('redacts a thrown error’s message and its cause’s, through captureRequestError', async () => {
    // Drizzle puts a failed statement's bound values in its message.
    const error = new Error(
      `Failed query: select * from listings where name like ?\nparams: ${PRIVATE}`,
      {
        cause: new Error(`D1_ERROR: no such table: listings: SQLITE_ERROR (${PRIVATE})`)
      }
    )
    Sentry.captureRequestError(
      error,
      {
        // Staging's admin key (#408) is a header too.
        headers: { cookie: `session=${PRIVATE}`, 'x-staging-admin-token': `key-${PRIVATE}` },
        method: 'GET',
        path: `/api/search/?q=${PRIVATE}`
      },
      { routePath: '/api/search', routeType: 'route', routerKind: 'App Router' }
    )
    const [event] = await waitForEvents(1)
    // The request data integration copied the cookie into the event, before the scrubber.
    expect(received[0]?.request?.headers?.cookie).toContain(PRIVATE)
    expect(received[0]?.request?.headers?.['x-staging-admin-token']).toContain(PRIVATE)
    expect(event?.exception?.values).toEqual([
      expect.objectContaining({ type: 'Error', value: REDACTED_MESSAGE }),
      expect.objectContaining({ type: 'Error', value: REDACTED_MESSAGE })
    ])
    expect(event?.exception?.values.at(-1)?.stacktrace?.frames?.length).toBeGreaterThan(0)
    expect(event?.request).toEqual({ method: 'GET' })
    expect(envelopes.join('\n')).not.toContain(PRIVATE)
  })

  it('redacts a rejected value or a message that is not an error', async () => {
    Sentry.captureException(`${PRIVATE}@example.com`)
    Sentry.captureException({ email: `${PRIVATE}@example.com` })
    Sentry.captureMessage(`typed ${PRIVATE}`)
    await waitForEvents(3)
    expect(envelopes.join('\n')).not.toContain(PRIVATE)
  })

  it('passes every allowlisted code through unchanged', async () => {
    for (const code of ERROR_CODES) Sentry.captureException(new Error(code))
    const events = await waitForEvents(ERROR_CODES.length)
    expect(events.map(event => event.exception?.values[0]?.value).sort()).toEqual(
      [...ERROR_CODES].sort()
    )
  })
})
