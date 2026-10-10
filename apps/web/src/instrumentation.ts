import type { Instrumentation } from 'next'
import {
  logRequestError,
  registerServerSentryStarter,
  reportsToServerSentry
} from './lib/telemetry/server-errors'

/**
 * Loads and starts the Worker's Sentry SDK (#48). Only the signed-in and operational surfaces
 * get here, so a public page never loads it (#355, `lib/telemetry/server-errors.ts`).
 */
async function serverSentry() {
  const sentry = await import('./lib/telemetry/server-sentry')
  sentry.startServerSentry()
  return sentry
}

/** Runs once per isolate; Sentry starts with the isolate's first request that reports to it. */
export async function register(): Promise<void> {
  await registerServerSentryStarter(async () => {
    await serverSentry()
  })
}

/**
 * Errors from server rendering, route handlers, and server actions: to Sentry from the
 * signed-in and operational surfaces, to the Worker's logs from public pages (#355).
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!reportsToServerSentry(request.path)) {
    logRequestError(error, request, context)
    return
  }
  const sentry = await serverSentry()
  sentry.captureRequestError(error, request, context)
}
