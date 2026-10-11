/**
 * Errors from the Worker entry outside Next.js, and from `scheduled()` (#210; docs/telemetry.md).
 *
 * Next.js reports its own render and route errors (`onRequestError`). These never reach it:
 * - **a request's error that escapes the Worker's `fetch`**: the redirects, the staging and admin
 *   gates, the edge HTML cache and the gone-listing render (`worker.ts`, `lib/worker/`);
 * - **a cron job's failure** (`lib/worker/scheduled.ts`). A cron isolate never starts Next.js, so
 *   it has no Sentry client of its own.
 *
 * Both follow #355's split. A request reports only from the signed-in and operational surfaces
 * (`reportsToServerSentry`); any other path is a public page, which keeps the runtime's log of
 * the exception, as before. The SDK (`worker-sentry.ts`) is imported only once there is an error
 * to report, so a public page, a cron run that succeeds, and a build without a DSN never load it.
 *
 * This module imports no package, only `./sentry`, `./server-errors` and `./error-fields`, which
 * import none either, so the Worker entry pays for Sentry only when it reports.
 */
import { errorFields } from './error-fields'
import { type SentryBuild, workerEnvironment } from './sentry'
import { reportsToServerSentry } from './server-errors'

/** One error for the Worker's Sentry client (`worker-sentry.ts`). */
export interface WorkerErrorReport {
  error: unknown
  /** How it reached the Worker entry: it escaped `fetch`, or it failed a scheduled job. */
  mechanism: 'cloudflare.fetch' | 'cloudflare.scheduled'
  /** A request's method and URL; the scrubber drops the query string. */
  request?: { method: string; url: string }
  /** `GET /admin/listings/`, or the job and its trigger. */
  transaction: string
}

/** A failed scheduled job (`handleScheduled`). */
export interface ScheduledJobFailure {
  error: unknown
  job: string
}

interface WorkerErrorEnv {
  SITE_ENVIRONMENT?: string
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void
}

export interface WorkerErrorsOptions {
  /** The deploy build's DSN and commit (`.open-next/worker-sentry.json`). No DSN, no reports. */
  build: SentryBuild
}

export function workerErrors({ build }: WorkerErrorsOptions) {
  /** Sends the reports and waits for them. Never throws: telemetry cannot fail the Worker. */
  async function report(reports: WorkerErrorReport[], env: WorkerErrorEnv): Promise<void> {
    try {
      // The only way to the SDK: Wrangler keeps this module behind a lazy initializer.
      const sentry = await import('./worker-sentry')
      await sentry.reportWorkerErrors(reports, {
        build,
        environment: workerEnvironment(env.SITE_ENVIRONMENT)
      })
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_sentry_failed', ...errorFields(error) }))
    }
  }

  return {
    /**
     * Runs the Worker's `fetch`. An error that escapes it is reported for a signed-in or
     * operational path, sent in `waitUntil`, and rethrown either way, so the response is the same
     * as before. An error Next.js already reported carries the SDK's captured marker, and the
     * client skips it (`worker-sentry.ts`).
     */
    async fetch(
      request: Request,
      env: WorkerErrorEnv,
      context: WaitUntil,
      handle: () => Promise<Response>
    ): Promise<Response> {
      try {
        return await handle()
      } catch (error) {
        const { pathname } = new URL(request.url)
        if (build.dsn && reportsToServerSentry(pathname)) {
          const { method, url } = request
          context.waitUntil(
            report(
              [
                {
                  error,
                  mechanism: 'cloudflare.fetch',
                  request: { method, url },
                  transaction: `${method} ${pathname}`
                }
              ],
              env
            )
          )
        }
        throw error
      }
    },

    /**
     * Reports a trigger's failed jobs, one event each, and waits for them, so they are sent
     * before the invocation ends. Never rejects.
     */
    async scheduled(
      failures: readonly ScheduledJobFailure[],
      cron: string,
      env: WorkerErrorEnv
    ): Promise<void> {
      if (!build.dsn || failures.length === 0) return
      await report(
        failures.map(({ error, job }) => ({
          error,
          mechanism: 'cloudflare.scheduled',
          transaction: `${job} (cron ${cron})`
        })),
        env
      )
    }
  }
}
