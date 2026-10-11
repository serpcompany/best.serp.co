/**
 * Shared Sentry settings for the Worker and the browser (#48; serp
 * docs/engineering/technology/telemetry.md). A report carries the error's type, its stable code,
 * its stack, the page path, the release, and the environment, never user data: no free-text
 * error messages (#211), IP, cookies, headers, query strings, request bodies, console output, or
 * user identity. Replay, tracing, and profiling stay off.
 *
 * The DSN is public and baked in at build time (`NEXT_PUBLIC_SENTRY_DSN`). Without it, as in
 * local runs or before the project exists, Sentry stays off: telemetry never breaks the site.
 */

type StackFrame = { abs_path?: unknown; filename?: unknown; [key: string]: unknown }

type ScrubbableEvent = {
  breadcrumbs?: Array<{ category?: string; data?: Record<string, unknown>; [key: string]: unknown }>
  contexts?: Record<string, unknown>
  environment?: string
  exception?: { values?: Array<{ stacktrace?: { frames?: StackFrame[] }; value?: unknown }> }
  extra?: unknown
  logentry?: { message?: unknown; params?: unknown }
  message?: unknown
  request?: { method?: string; url?: string; [key: string]: unknown }
  tags?: Record<string, unknown>
  transaction?: unknown
  user?: unknown
  [key: string]: unknown
}

/**
 * Contexts the SDK adds about the runtime. Anything else, such as the shared logger's `data`
 * (which can hold a visitor's search), never leaves.
 */
const ALLOWED_CONTEXTS = new Set([
  'app',
  'browser',
  'device',
  'nextjs',
  'os',
  'react',
  'runtime',
  'trace'
])
/** Tags the SDK adds; the logger's own tags are dropped like its data. */
const ALLOWED_TAGS = new Set(['runtime', 'turbopack'])

/**
 * The stable error codes a report's message may carry (#211; serp telemetry standard, Required
 * Defaults item 3). Each is a fixed string thrown or logged as the message, such as the shared
 * logger's `logger.error('search_failed')`. Kept here, beside the scrubber that holds every
 * other message to it, so this module stays import-free.
 */
export const ERROR_CODES = [
  'search_entry_check_failed',
  'search_entry_transform_failed',
  'search_failed',
  'search_lenient_processing_failed',
  'search_query_match_failed'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

const STABLE_MESSAGES: ReadonlySet<unknown> = new Set(ERROR_CODES)

/** What replaces any other message: the error's type and stack still say what failed. */
export const REDACTED_MESSAGE = '[redacted]'

/**
 * A message that is an allowlisted code, as it is; any other text, redacted. A thrown error's
 * message can hold what a visitor typed, a validation error can echo a field, and Drizzle adds a
 * failed statement's bound values to its message, so no free text leaves.
 */
function stableMessage(message: unknown): unknown {
  if (typeof message !== 'string' || message === '') return message
  return STABLE_MESSAGES.has(message) ? message : REDACTED_MESSAGE
}

export type SiteEnvironment = 'local' | 'production' | 'staging'

export function stripQuery(url: string): string {
  return url.replace(/[?#].*$/u, '')
}

/** Removes user data from an event before it leaves the Worker or the browser. */
export function scrubEvent<E>(input: E): E {
  const event = input as ScrubbableEvent
  delete event.user
  delete event.extra
  if (event.message !== undefined) event.message = stableMessage(event.message)
  if (event.logentry) event.logentry = { message: stableMessage(event.logentry.message) }
  if (event.request) {
    const { method, url } = event.request
    event.request = { ...(url ? { url: stripQuery(url) } : {}), ...(method ? { method } : {}) }
  }
  if (typeof event.transaction === 'string') event.transaction = stripQuery(event.transaction)
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!ALLOWED_CONTEXTS.has(key)) delete event.contexts[key]
    }
    // Next.js reports the requested path with its query string.
    const nextjs = event.contexts.nextjs as { request_path?: unknown } | undefined
    if (typeof nextjs?.request_path === 'string')
      nextjs.request_path = stripQuery(nextjs.request_path)
  }
  if (event.tags) {
    for (const key of Object.keys(event.tags)) {
      if (!ALLOWED_TAGS.has(key)) delete event.tags[key]
    }
  }
  for (const exception of event.exception?.values ?? []) {
    // Every exception in the chain: the SDK adds an error's `cause` as one more.
    if (exception.value !== undefined) exception.value = stableMessage(exception.value)
    // The browser names a frame after the page URL, query string included.
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (typeof frame.filename === 'string') frame.filename = stripQuery(frame.filename)
      if (typeof frame.abs_path === 'string') frame.abs_path = stripQuery(frame.abs_path)
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      // Console messages can carry form input and other user text.
      .filter(crumb => crumb.category !== 'console')
      .map(crumb => {
        const url = crumb.data?.url
        if (typeof url !== 'string') return { ...crumb, data: undefined }
        const { method, status_code: statusCode } = crumb.data ?? {}
        return { ...crumb, data: { method, status_code: statusCode, url: stripQuery(url) } }
      })
  }
  return input
}

/** The release both sides report: the deployed commit, set by the deploy build. */
export function sentryRelease(commit: string | undefined): string | undefined {
  return commit && /^[0-9a-f]{7,40}$/u.test(commit) ? `best-serp-co@${commit}` : undefined
}

/** The Worker's environment, from its `SITE_ENVIRONMENT` var; anything else counts as local. */
export function workerEnvironment(value: string | undefined): SiteEnvironment {
  return value === 'production' || value === 'staging' ? value : 'local'
}

/**
 * The browser's environment, from the host it was served on: staging's canonical host
 * (`STAGING_CANONICAL_HOST` in lib/environment/site-environment.ts, #323) or its workers.dev
 * host. This module stays import-free (next.config.ts loads it), so the hosts are spelled here
 * and sentry.test.ts holds them to site-environment.ts.
 */
export function browserEnvironment(hostname: string): SiteEnvironment {
  if (hostname === 'best.serp.co') return 'production'
  if (hostname === 'staging.best.serp.co' || hostname.startsWith('best-serp-co-staging.'))
    return 'staging'
  return 'local'
}

/** Errors only: no session per page view (browser) or per isolate (Worker). */
const SESSION_INTEGRATIONS = new Set(['BrowserSession', 'ProcessSession'])

/** What the deploy build bakes in (#48): the public DSN and the deployed commit. */
export interface SentryBuild {
  commit?: string
  dsn?: string
}

/**
 * The Next.js build's values, inlined at build time. The Worker entry, which Wrangler bundles at
 * deploy without them, reads the same values from the build output (`worker-errors.ts`, #210).
 */
function nextBuild(): SentryBuild {
  return {
    commit: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN
  }
}

export function sentryOptions(environment: () => SiteEnvironment, build = nextBuild()) {
  const dsn = build.dsn || undefined
  return {
    beforeSend<E extends { environment?: string }>(event: E): E {
      // Resolved per event too: on the Worker, vars reach process.env with the first request.
      event.environment = environment()
      return scrubEvent(event)
    },
    dsn,
    enabled: Boolean(dsn),
    environment: environment(),
    integrations: <I extends { name: string }>(defaults: I[]): I[] =>
      defaults.filter(integration => !SESSION_INTEGRATIONS.has(integration.name)),
    maxBreadcrumbs: 30,
    release: sentryRelease(build.commit),
    sendDefaultPii: false,
    // Tracing stays off: no `tracesSampleRate` at all (0 would still make spans), and no trace
    // headers on the site's own requests.
    tracePropagationTargets: []
  }
}
