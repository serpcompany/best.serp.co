import {
  createStackParser,
  createTransport,
  type ErrorEvent,
  type Event,
  inboundFiltersIntegration,
  ServerRuntimeClient
} from '@sentry/core'
import * as Sentry from '@sentry/nextjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntryFailures, validateEntries } from '@/components/search/use-search-helpers'
import type { SearchResult } from '@/lib/directory/search-contract'
import { logger } from '@/lib/logging'
import { browserSentryOptions, ERROR_CODES, REDACTED_MESSAGE, sentryOptions } from './sentry'

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

/** The events in a transport's envelopes. */
function eventsIn(sent: string[]): SentEvent[] {
  return sent.flatMap(
    envelope =>
      envelope
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(item => 'exception' in item || 'message' in item) as unknown as SentEvent[]
  )
}

/** The events sent since the test began, flushed from the client. */
async function sentEvents(): Promise<SentEvent[]> {
  await client.flush(2000)
  return eventsIn(envelopes)
}

async function waitForEvents(count: number) {
  await vi.waitFor(async () => {
    expect(await sentEvents()).toHaveLength(count)
  })
  return sentEvents()
}

describe('what reaches Sentry (#211)', () => {
  it('reports a logger call as its code and the caught error’s type, with none of its data', async () => {
    // A real call site: a search result that fails its check, holding what a visitor typed.
    const broken = { name: `${PRIVATE} @ example.com`, slug: 'broken' } as unknown as SearchResult
    const failures = new EntryFailures()
    expect(validateEntries([broken], failures)).toEqual([])
    failures.report()
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
    expect(Object.keys(byCode).sort()).toEqual(['search_entry_check_failed', 'search_failed'])
    // The caught error goes as the code's cause: its type and frames, its message redacted.
    expect(byCode.search_entry_check_failed?.exception?.values).toEqual([
      expect.objectContaining({ type: 'TypeError', value: REDACTED_MESSAGE }),
      expect.objectContaining({ type: 'Error', value: 'search_entry_check_failed' })
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

/** A client's filters and `beforeSend`, from either side's settings. */
interface FilterOptions {
  beforeSend(event: ErrorEvent): ErrorEvent | null
  denyUrls?: RegExp[]
  ignoreErrors?: Array<RegExp | string>
}

/**
 * Sends raw events through a client of their own with the browser SDK's event filters: the first
 * of its default integrations, which applies `ignoreErrors` and `denyUrls` before `beforeSend`.
 * Returns each event as `beforeSend` received it, and what was sent.
 */
async function throughFilters(options: FilterOptions, events: Event[]) {
  const sent: string[] = []
  const seen: SentEvent[] = []
  const filtering = new ServerRuntimeClient({
    beforeSend(event) {
      seen.push(structuredClone(event) as SentEvent)
      return options.beforeSend(event)
    },
    denyUrls: options.denyUrls,
    dsn: 'https://public@o1.ingest.sentry.io/2',
    ignoreErrors: options.ignoreErrors,
    integrations: [inboundFiltersIntegration()],
    platform: 'javascript',
    stackParser: createStackParser(),
    transport: transportOptions =>
      createTransport(transportOptions, async request => {
        sent.push(
          typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)
        )
        return {}
      })
  })
  filtering.init()
  for (const event of events) filtering.captureEvent(structuredClone(event))
  await filtering.close(2000)
  return { seen, sent: eventsIn(sent) }
}

const CHUNK = 'https://best.serp.co/_next/static/chunks/0f1e2d3c4b5a.js'
const FIRST_PARTY_FRAMES = [
  { colno: 9, filename: CHUNK, function: 'ListingCard', in_app: true, lineno: 1 }
]

/** An error event as the browser SDK's global handlers build one: frames outermost first. */
function browserError(type: string, value: string, frames: object[] = FIRST_PARTY_FRAMES): Event {
  return {
    exception: {
      values: [
        {
          mechanism: { handled: false, type: 'auto.browser.global_handlers.onunhandledrejection' },
          stacktrace: { frames },
          type,
          value
        }
      ]
    },
    level: 'error',
    platform: 'javascript'
  }
}

const minifiedReactError = (code: number) =>
  `Minified React error #${code}; visit https://react.dev/errors/${code} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`

/** The noise #401 found in production, and the kinds Sentry's inbound filters used to drop. */
const FILTERED_NOISE = [
  // BEST-SERP-CO-7.
  browserError(
    'ChunkLoadError',
    'Failed to load chunk /_next/static/chunks/0f1e2d3c4b5a.js from module 81234'
  ),
  browserError(
    'ChunkLoadError',
    'Loading chunk 123 failed.\n(error: https://best.serp.co/_next/static/chunks/123.js)'
  ),
  browserError('Error', 'Loading CSS chunk 456 failed.\n(/_next/static/css/456.css)'),
  // BEST-SERP-CO-8, and the other hydration errors.
  browserError('Error', minifiedReactError(418)),
  browserError('Error', minifiedReactError(423)),
  browserError('Error', minifiedReactError(425)),
  browserError(
    'Error',
    "Hydration failed because the server rendered HTML didn't match the client."
  ),
  browserError('Error', 'ResizeObserver loop limit exceeded'),
  browserError('TypeError', "Cannot read properties of null (reading 'shadowRoot')", [
    {
      colno: 12,
      filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js',
      function: 'observe',
      in_app: true,
      lineno: 2
    }
  ])
]

/** BEST-SERP-CO-9: an injected script's stack, ending in the SDK's own fetch wrapper. */
const INJECTED_SCRIPT = browserError('TypeError', "Failed to construct 'Headers': Invalid name", [
  { colno: 17, filename: '<anonymous>', function: 'HTMLDocument.<anonymous>', lineno: 39 },
  { colno: 20, filename: '<anonymous>', function: 'handlePageLoad', lineno: 34 },
  { colno: 13, filename: '<anonymous>', function: '?', lineno: 17 },
  { colno: 9, filename: '<anonymous>', function: 'magicRPC', lineno: 5 },
  { colno: 49, filename: CHUNK, function: 's.headers', lineno: 1 }
])

const FIRST_PARTY = browserError(
  'TypeError',
  "Cannot read properties of undefined (reading 'slug')"
)

describe('what the browser drops before its messages are redacted (#422)', () => {
  const browser = browserSentryOptions(() => 'production', {
    dsn: 'https://public@o1.ingest.sentry.io/2'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops chunk-load, hydration, ResizeObserver, extension and injected-script errors', async () => {
    const { seen, sent } = await throughFilters(browser, [...FILTERED_NOISE, INJECTED_SCRIPT])
    expect(sent).toEqual([])
    // The filters matched the raw messages, so only the injected script reached `beforeSend`.
    expect(seen.map(event => event.exception?.values[0]?.value)).toEqual([
      "Failed to construct 'Headers': Invalid name"
    ])
  })

  it('would send every one of them, redacted, with the shared settings alone', async () => {
    const { sent } = await throughFilters(
      sentryOptions(() => 'production'),
      [...FILTERED_NOISE, INJECTED_SCRIPT]
    )
    expect(sent.map(event => event.exception?.values[0]?.value)).toEqual(
      Array(FILTERED_NOISE.length + 1).fill(REDACTED_MESSAGE)
    )
  })

  it('still sends a first-party error, with its message redacted', async () => {
    // A first-party stack cut off at a built-in's frame, which has no line, is not injected.
    const cutAtBuiltIn = browserError(
      'TypeError',
      "Cannot read properties of null (reading 'id')",
      [{ filename: '<anonymous>', function: 'Array.forEach' }, ...FIRST_PARTY_FRAMES]
    )
    const { seen, sent } = await throughFilters(browser, [FIRST_PARTY, cutAtBuiltIn])
    expect(seen.map(event => event.exception?.values[0]?.value)).toEqual([
      "Cannot read properties of undefined (reading 'slug')",
      "Cannot read properties of null (reading 'id')"
    ])
    expect(sent.map(event => event.exception?.values[0])).toEqual([
      expect.objectContaining({ type: 'TypeError', value: REDACTED_MESSAGE }),
      expect.objectContaining({ type: 'TypeError', value: REDACTED_MESSAGE })
    ])
  })

  it('still sends React error 419, a server render failure, with its message redacted', async () => {
    const { seen, sent } = await throughFilters(browser, [
      browserError('Error', minifiedReactError(419))
    ])
    expect(seen.map(event => event.exception?.values[0]?.value)).toEqual([minifiedReactError(419)])
    expect(sent.map(event => event.exception?.values[0])).toEqual([
      expect.objectContaining({ type: 'Error', value: REDACTED_MESSAGE })
    ])
  })

  it('drops every error from an automated browser', async () => {
    vi.stubGlobal('navigator', { webdriver: true })
    const { seen, sent } = await throughFilters(browser, [FIRST_PARTY])
    expect(seen).toHaveLength(1)
    expect(sent).toEqual([])
  })
})
