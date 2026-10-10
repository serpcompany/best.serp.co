import * as Sentry from '@sentry/nextjs'
import { sentryOptions, workerEnvironment } from './sentry'

/**
 * The Worker's Sentry SDK (#48). Only `src/instrumentation.ts` loads this module, with a dynamic
 * import, for the requests that report to Sentry (`server-errors.ts`, #355): a public page never
 * loads the SDK.
 */
let started = false

/**
 * Starts Sentry in this isolate, once; it stays off without a DSN. An `init` that throws leaves it
 * unstarted and throws again on the next call, so `onRequestError` logs that request's error
 * instead of handing it to a client that never started.
 */
export function startServerSentry(): void {
  if (started) return
  Sentry.init(sentryOptions(() => workerEnvironment(process.env.SITE_ENVIRONMENT)))
  started = true
}

/** Reports errors from server rendering, route handlers, and server actions. */
export const captureRequestError = Sentry.captureRequestError
