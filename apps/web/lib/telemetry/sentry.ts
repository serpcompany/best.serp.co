/**
 * Shared Sentry settings for the Worker and the browser (#48; serp
 * docs/engineering/technology/telemetry.md). A report carries the error, its stack, the page
 * path, the release, and the environment, never user data: no IP, cookies, headers, query
 * strings, request bodies, console output, or user identity. Replay, tracing, and profiling stay
 * off.
 *
 * The DSN is public and baked in at build time (`NEXT_PUBLIC_SENTRY_DSN`). Without it, as in
 * local runs or before the project exists, Sentry stays off: telemetry never breaks the site.
 */

type StackFrame = { abs_path?: unknown; filename?: unknown; [key: string]: unknown }

type ScrubbableEvent = {
  breadcrumbs?: Array<{ category?: string; data?: Record<string, unknown>; [key: string]: unknown }>
  contexts?: Record<string, unknown>
  environment?: string
  exception?: { values?: Array<{ stacktrace?: { frames?: StackFrame[] } }> }
  extra?: unknown
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

export type SiteEnvironment = 'local' | 'production' | 'staging'

export function stripQuery(url: string): string {
  return url.replace(/[?#].*$/u, '')
}

/** Removes user data from an event before it leaves the Worker or the browser. */
export function scrubEvent<E>(input: E): E {
  const event = input as ScrubbableEvent
  delete event.user
  delete event.extra
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
  // The browser names a frame after the page URL, query string included.
  for (const exception of event.exception?.values ?? []) {
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

/** The browser's environment, from the host it was served on. */
export function browserEnvironment(hostname: string): SiteEnvironment {
  if (hostname === 'best.serp.co') return 'production'
  if (hostname.startsWith('best-serp-co-staging.')) return 'staging'
  return 'local'
}

export function sentryOptions(environment: () => SiteEnvironment) {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined
  return {
    beforeSend<E extends { environment?: string }>(event: E): E {
      // Resolved per event too: on the Worker, vars reach process.env with the first request.
      event.environment = environment()
      return scrubEvent(event)
    },
    dsn,
    enabled: Boolean(dsn),
    environment: environment(),
    maxBreadcrumbs: 30,
    release: sentryRelease(process.env.NEXT_PUBLIC_SENTRY_RELEASE),
    sendDefaultPii: false,
    // Tracing stays off: no `tracesSampleRate` at all (0 would still make spans), and no trace
    // headers on the site's own requests.
    tracePropagationTargets: []
  }
}
