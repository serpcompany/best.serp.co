import {
  createStackParser,
  createTransport,
  dedupeIntegration,
  linkedErrorsIntegration,
  nodeStackLineParser,
  Scope,
  ServerRuntimeClient
} from '@sentry/core'
import { type SentryBuild, type SiteEnvironment, sentryOptions } from './sentry'
import type { WorkerErrorReport } from './worker-errors'

/**
 * The Worker entry's Sentry client (#210). Only `worker-errors.ts` loads this module, with a
 * dynamic import, once a cron job or a signed-in or operational request has an error to report:
 * a public page never loads it (#355).
 *
 * It has the Next.js server SDK's settings (`sentryOptions`: the DSN, release, environment and
 * `scrubEvent`), from the build values the deploy build recorded. It is a client of its own,
 * never installed globally, with only the integrations that patch nothing: the Next.js server SDK
 * (`server-sentry.ts`) can run in the same isolate, and this one must neither replace its client
 * nor wrap `fetch` and `console` for the isolate's later requests.
 */
let client: ServerRuntimeClient | undefined

/** How long a report may take to send; Sentry's Cloudflare SDK waits as long. */
const FLUSH_TIMEOUT_MS = 2000

function workerClient(build: SentryBuild, environment: SiteEnvironment): ServerRuntimeClient {
  if (client) return client
  const options = sentryOptions(() => environment, build)
  client = new ServerRuntimeClient({
    ...options,
    // Duplicates, and an error's `cause` chain, which the scrubber redacts link by link.
    integrations: options.integrations([dedupeIntegration(), linkedErrorsIntegration()]),
    platform: 'javascript',
    runtime: { name: 'cloudflare' },
    stackParser: createStackParser(nodeStackLineParser()),
    transport: transportOptions =>
      createTransport(transportOptions, async request => {
        const response = await fetch(transportOptions.url, {
          // The SDK encodes each envelope with TextEncoder, so its bytes own an ArrayBuffer.
          body: request.body as string | Uint8Array<ArrayBuffer>,
          headers: transportOptions.headers,
          method: 'POST'
        })
        return {
          headers: {
            'retry-after': response.headers.get('Retry-After'),
            'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits')
          },
          statusCode: response.status
        }
      })
  })
  client.init()
  return client
}

/**
 * Captures each error, one event apiece, and waits until they are sent. OpenNext answers Next.js's
 * own errors with the error page, so they rarely reach the Worker entry; one that does, after the
 * Next.js server SDK captured it, is skipped: every copy of the SDK marks the error object it
 * captures (`__sentry_captured__`) and passes over a marked one, so it is never reported twice.
 */
export async function reportWorkerErrors(
  reports: readonly WorkerErrorReport[],
  { build, environment }: { build: SentryBuild; environment: SiteEnvironment }
): Promise<void> {
  const sentry = workerClient(build, environment)
  for (const { error, mechanism, request, transaction } of reports) {
    const scope = new Scope()
    scope.setTransactionName(transaction)
    if (request) scope.addEventProcessor(event => ({ ...event, request }))
    // The linked-errors integration follows `originalException` down the `cause` chain. The
    // mechanism goes in `data`, where the SDK applies it as it builds the error's own exception;
    // a top-level `mechanism` lands on whichever exception comes first, the deepest cause.
    sentry.captureException(
      error,
      { data: { mechanism: { handled: false, type: mechanism } }, originalException: error },
      scope
    )
  }
  await sentry.flush(FLUSH_TIMEOUT_MS)
}
