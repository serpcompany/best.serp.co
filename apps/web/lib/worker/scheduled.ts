/**
 * The Worker's scheduled handler (Cloudflare Cron Triggers, `triggers.crons` in
 * `apps/web/wrangler.jsonc`). `apps/web/worker.ts` only wires `scheduled()` to
 * `handleScheduled`; the jobs live here so they are type-checked and unit-tested.
 *
 * Each cron expression maps to the jobs it runs. Today one hourly trigger runs the draft
 * reminders and expiry (#63), so the +12h reminder goes out within the hour it falls due. The weekly badge program (#66) adds its own expression and job
 * to `scheduledJobs` and to `triggers.crons`; a trigger with no jobs here is logged and ignored.
 *
 * Like the request path, it fails closed: without a valid `DB` binding and `D1_RUNTIME_ENV`,
 * a job throws instead of guessing. Emails go through the same email module as requests
 * (`createWorkerEmailService`), which disables itself when delivery is not configured.
 */
import { createDatabase } from '@serpdirectory/data-ops/client'
import { createDraftJobOperations } from '@serpdirectory/data-ops/draft-jobs'
import { site } from '@serpdirectory/site-config'
import { appEmailTemplates } from '../email/registry'
import { createWorkerEmailService, type EmailWorkerEnv } from '../email/runtime'
import { runDraftJobs } from '../submissions/draft-jobs'

/** Hourly, on the hour: each draft reminder goes out within an hour of falling due. */
export const DRAFT_JOBS_CRON = '0 * * * *'

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

export interface ScheduledEnv extends EmailWorkerEnv {
  D1_RUNTIME_ENV?: string
  DB?: D1Database
}

export interface ScheduledEvent {
  cron: string
  scheduledTime: number
}

export interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface ScheduledJobInput {
  context: ScheduledContext
  env: ScheduledEnv
  /** When the trigger was scheduled to fire; jobs use it as "now". */
  now: Date
}

export interface ScheduledJob {
  name: string
  run(input: ScheduledJobInput): Promise<Record<string, unknown>>
}

function database(env: ScheduledEnv): D1Database {
  if (!env.DB) throw new Error('D1 binding DB is required for scheduled jobs.')
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV ?? '')) {
    throw new Error('A valid D1_RUNTIME_ENV is required for scheduled jobs.')
  }
  return env.DB
}

export const draftJobs: ScheduledJob = {
  name: 'draft-reminders-and-expiry',
  async run({ context, env, now }) {
    const jobs = createDraftJobOperations({ client: createDatabase(database(env)) })
    // The email service delivers through `waitUntil`; collecting each delivery lets the job
    // await it, so the run sends one email at a time instead of firing a whole batch.
    const deliveries: Promise<unknown>[] = []
    const email = createWorkerEmailService({
      context: {
        waitUntil(promise) {
          deliveries.push(promise)
          context.waitUntil(promise)
        }
      },
      env,
      templates: appEmailTemplates
    })
    const result = await runDraftJobs({
      jobs,
      now,
      paidListings: site.features.showPaidListings,
      priceCents: site.submissions.paidListingPriceCents,
      async send(templateId, request) {
        email.enqueue(templateId, request)
        await Promise.allSettled(deliveries.splice(0))
      }
    })
    return { ...result }
  }
}

export const scheduledJobs: Readonly<Record<string, readonly ScheduledJob[]>> = {
  [DRAFT_JOBS_CRON]: [draftJobs]
}

function log(level: 'error' | 'info' | 'warn', entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

/**
 * Runs every job of the trigger's cron expression, one after another. A failing job is logged
 * and does not stop the others; the invocation then fails, so the Cron Trigger shows it.
 */
export async function handleScheduled(
  event: ScheduledEvent,
  env: ScheduledEnv,
  context: ScheduledContext,
  jobs: Readonly<Record<string, readonly ScheduledJob[]>> = scheduledJobs
): Promise<void> {
  const scheduled = jobs[event.cron]
  if (!scheduled) {
    log('warn', { cron: event.cron, event: 'scheduled_trigger_unknown' })
    return
  }
  const now = new Date(event.scheduledTime)
  const failures: unknown[] = []
  for (const job of scheduled) {
    try {
      const result = await job.run({ context, env, now })
      log('info', { cron: event.cron, event: 'scheduled_job_finished', job: job.name, ...result })
    } catch (error) {
      failures.push(error)
      log('error', {
        cron: event.cron,
        event: 'scheduled_job_failed',
        job: job.name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} scheduled job(s) failed.`)
  }
}
