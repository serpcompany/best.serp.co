import * as Sentry from '@sentry/nextjs'
import { sentryOptions, workerEnvironment } from './sentry'

/**
 * The Worker's Sentry SDK (#48). Only `src/instrumentation.ts` loads this module, with a dynamic
 * import, for the requests that report to Sentry (`server-errors.ts`, #355): a public page never
 * loads the SDK.
 */
let started = false

/** Starts Sentry in this isolate, once; it stays off without a DSN. */
export function startServerSentry(): void {
  if (started) return
  started = true
  Sentry.init(sentryOptions(() => workerEnvironment(process.env.SITE_ENVIRONMENT)))
}

/** Reports errors from server rendering, route handlers, and server actions. */
export const captureRequestError = Sentry.captureRequestError
