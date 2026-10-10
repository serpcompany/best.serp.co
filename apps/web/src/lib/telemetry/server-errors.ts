/**
 * Where the Worker's server errors go (#355, the owner's option 3; docs/telemetry.md).
 *
 * The Sentry server SDK costs about 110 ms of CPU in each fresh isolate (#334), and search
 * crawlers mostly see uncached public pages in fresh isolates. So only the signed-in and
 * operational surfaces start it: `/admin`, `/account`, `/submit`, `/login`, `/claims` and
 * `/api`. Every other path is a public page whose request errors go to the Worker's logs as
 * one JSON line (`logRequestError`), which Workers Observability keeps.
 *
 * Starting the SDK takes both halves of the isolate, which share only `globalThis`:
 * - the Worker entry (`worker.ts`, bundled by Wrangler) sees every request first, and calls
 *   `startServerSentryFor` before Next.js renders one that reports to Sentry;
 * - Next.js calls `register()` in `src/instrumentation.ts` (bundled by Turbopack) once per
 *   isolate, while it serves the isolate's first request, and that hands the starter over
 *   through `registerServerSentryStarter`.
 *
 * Whichever runs second starts the SDK, so a reporting request never renders without it. This
 * module imports nothing but `./sentry` (itself import-free), so neither bundle pays for Sentry.
 */
import { stripQuery } from './sentry'

/** The path prefixes whose requests report to Sentry: everything signed in or operational. */
const SERVER_SENTRY_SURFACES = ['/account', '/admin', '/api', '/claims', '/login', '/submit']

/** Whether a request for this path (query string allowed) reports its errors to Sentry. */
export function reportsToServerSentry(path: string): boolean {
  const pathname = stripQuery(path)
  return SERVER_SENTRY_SURFACES.some(
    surface => pathname === surface || pathname.startsWith(`${surface}/`)
  )
}

interface ServerSentrySwitch {
  /** A reporting request reached the Worker entry; `register()` starts the SDK if it comes later. */
  requested: boolean
  /** Starts the SDK once; set by `register()`. */
  start?: () => Promise<void>
}

const SWITCH = Symbol.for('best.serp.co/server-sentry')

function serverSentrySwitch(): ServerSentrySwitch {
  const scope = globalThis as typeof globalThis & { [SWITCH]?: ServerSentrySwitch }
  scope[SWITCH] ??= { requested: false }
  return scope[SWITCH]
}

/** The Worker entry, before Next.js renders `request`: starts Sentry first if it reports to it. */
export async function startServerSentryFor(request: Request): Promise<void> {
  if (!reportsToServerSentry(new URL(request.url).pathname)) return
  const serverSentry = serverSentrySwitch()
  serverSentry.requested = true
  await serverSentry.start?.()
}

/**
 * `register()` in `src/instrumentation.ts`: keeps the starter for later requests, and runs it now
 * if a reporting request is already waiting. A failure to start is logged, never thrown, so
 * telemetry cannot fail a request.
 */
export async function registerServerSentryStarter(start: () => Promise<void>): Promise<void> {
  const serverSentry = serverSentrySwitch()
  let started: Promise<void> | undefined
  serverSentry.start = () => {
    started ??= start().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'server_sentry_start_failed',
          message: error instanceof Error ? error.message : String(error)
        })
      )
    })
    return started
  }
  if (serverSentry.requested) await serverSentry.start()
}

/** What `onRequestError` passes (`Instrumentation.onRequestError` in `next`). */
interface ErroredRequest {
  readonly method: string
  readonly path: string
}

interface RequestErrorContext {
  readonly renderSource?: string
  readonly revalidateReason?: string
  readonly routePath: string
  readonly routeType: string
}

/**
 * A public page's request error, as one JSON line on `console.error` for Workers Observability.
 * Like a Sentry report it carries the error and the route, never user data: the path without
 * its query string, and no headers.
 */
export function logRequestError(
  error: unknown,
  request: ErroredRequest,
  context: RequestErrorContext
): void {
  const thrown = error instanceof Error ? error : undefined
  const digest = (error as { digest?: unknown } | null)?.digest
  console.error(
    JSON.stringify({
      event: 'request_error',
      method: request.method,
      path: stripQuery(request.path),
      route: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
      revalidateReason: context.revalidateReason,
      digest: typeof digest === 'string' ? digest : undefined,
      name: thrown?.name,
      message: thrown ? thrown.message : String(error),
      stack: thrown?.stack
    })
  )
}
