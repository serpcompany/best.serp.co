import * as Sentry from '@sentry/nextjs'
import { sentryOptions, workerEnvironment } from './lib/telemetry/sentry'

/** Starts Sentry in the Worker (#48); it stays off without a DSN. */
export function register(): void {
  Sentry.init(sentryOptions(() => workerEnvironment(process.env.SITE_ENVIRONMENT)))
}

/** Reports errors from server rendering, route handlers, and server actions. */
export const onRequestError = Sentry.captureRequestError
