/**
 * The Worker's `scheduled()` (#424): loads the cron jobs (`./scheduled`) when a trigger fires
 * rather than at a new isolate's start-up, then runs them through `handleScheduled`.
 *
 * The jobs' module graph (email templates, billing, the badge program, the media queue) now
 * evaluates on the first trigger, so an error there rejects the load instead of failing the
 * deploy's start-up check. That rejection is reported like a failed job, as
 * `load-scheduled-jobs`, through the same reporter (#210), and rethrown so the invocation still
 * ends as an exception.
 *
 * It imports `./scheduled` for types only: a value import would put the jobs back on the
 * start-up path.
 */
import { errorFields } from '../telemetry/error-fields'
import type { ScheduledJobFailure } from '../telemetry/worker-errors'
import type {
  ReportScheduledFailures,
  ScheduledContext,
  ScheduledEnv,
  ScheduledEvent
} from './scheduled'

/** The job name a failed load is reported and logged under. */
export const LOAD_SCHEDULED_JOBS = 'load-scheduled-jobs'

/** What `scheduled()` needs from `./scheduled`. */
export type ScheduledJobsModule = Pick<
  typeof import('./scheduled'),
  'handleScheduled' | 'scheduledJobs'
>

export interface RunScheduledOptions {
  /** `() => import('./scheduled')` in the Worker entry. */
  load: () => Promise<ScheduledJobsModule>
  /** Sends failures to Sentry (`workerErrors().scheduled`); never rejects. */
  reportFailures: ReportScheduledFailures
}

export async function runScheduled(
  event: ScheduledEvent,
  env: ScheduledEnv,
  context: ScheduledContext,
  { load, reportFailures }: RunScheduledOptions
): Promise<void> {
  let jobs: ScheduledJobsModule
  try {
    jobs = await load()
  } catch (error) {
    const failure: ScheduledJobFailure = { error, job: LOAD_SCHEDULED_JOBS }
    console.error(
      JSON.stringify({
        cron: event.cron,
        event: 'scheduled_job_failed',
        job: LOAD_SCHEDULED_JOBS,
        ...errorFields(error)
      })
    )
    await reportFailures([failure])
    throw error
  }
  return jobs.handleScheduled(event, env, context, jobs.scheduledJobs, reportFailures)
}
