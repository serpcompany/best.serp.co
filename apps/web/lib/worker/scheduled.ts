/**
 * The Worker's scheduled handler (Cloudflare Cron Triggers, `triggers.crons` in
 * `apps/web/wrangler.jsonc`). `apps/web/worker.ts` only wires `scheduled()` to
 * `handleScheduled`; the jobs live here so they are type-checked and unit-tested.
 *
 * Each cron expression maps to the jobs it runs. The hourly trigger runs the draft reminders
 * and expiry (#63), so the +12h reminder goes out within the hour it falls due, and continues
 * the badge program (#66) in batches, then the billing sweep (#68); the badge program's weekly
 * trigger opens its cycle and
 * its daily trigger its confirmation rechecks (`lib/badge-program/schedule.ts`). A 15-minute
 * trigger hosts the queued listing media (#95). A trigger with no jobs here is logged and
 * ignored.
 *
 * Like the request path, it fails closed: without a valid `DB` binding and `D1_RUNTIME_ENV`,
 * a job throws instead of guessing. Emails go through the same email module as requests
 * (`createWorkerEmailService`), which disables itself when delivery is not configured.
 */
import { createBadgeProgramOperations } from '@serpdirectory/data-ops/badge-program'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { createDraftJobOperations } from '@serpdirectory/data-ops/draft-jobs'
import { site } from '@serpdirectory/site-config'
import { runBadgeProgram } from '../badge-program/program'
import { BADGE_DAILY_CRON, BADGE_WEEKLY_CRON } from '../badge-program/schedule'
import { ordersEnabledFor } from '../billing/flags'
import { runBillingSweep } from '../billing/service'
import { type BillingEnv, createBillingDependencies } from '../billing/worker-billing'
import { appEmailTemplates } from '../email/registry'
import { createWorkerEmailService, type EmailWorkerEnv } from '../email/runtime'
import { type SiteFeatures, features as siteFeatures } from '../features'
import { runMediaCron } from '../media/worker-media'
import { verifyFeaturedBadge } from '../submissions/badge-verifier'
import { runDraftJobs } from '../submissions/draft-jobs'
import { submissionBadgeVerificationTargets } from '../submissions/presentation'

/** Hourly, on the hour: each draft reminder goes out within an hour of falling due. */
export const DRAFT_JOBS_CRON = '0 * * * *'

/** Every 15 minutes: the first media retry falls due 15 minutes after a failed attempt. */
export const MEDIA_CRON = '*/15 * * * *'

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

export interface ScheduledEnv extends EmailWorkerEnv, BillingEnv {
  D1_RUNTIME_ENV?: string
  /**
   * `on` runs the badge program on a local Worker while `features.badgeProgram` is off
   * (`LOCAL_PREVIEW_VARS`; unused since #130 turned the flag on). Ignored unless
   * `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` are both `local`.
   */
  LOCAL_BADGE_PROGRAM?: string
  MEDIA?: R2Bucket
  SITE_ENVIRONMENT?: string
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

/**
 * The badge program runs only while `features.badgeProgram` is on (on since #130, the owner's
 * launch decision), or on a local Worker that asks for it.
 */
export function badgeProgramEnabled(
  env: ScheduledEnv,
  features: SiteFeatures = siteFeatures
): boolean {
  if (features.badgeProgram) return true
  return (
    env.LOCAL_BADGE_PROGRAM === 'on' &&
    env.SITE_ENVIRONMENT === 'local' &&
    env.D1_RUNTIME_ENV === 'local'
  )
}

/**
 * A worker email service whose sends the job can await one at a time: the service delivers
 * through `waitUntil`, and collecting each delivery lets the job wait for it instead of firing a
 * whole batch at once.
 */
function sequentialEmail(context: ScheduledContext, env: ScheduledEnv) {
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
  return {
    async send(...args: Parameters<typeof email.enqueue>): Promise<void> {
      email.enqueue(...args)
      await Promise.allSettled(deliveries.splice(0))
    }
  }
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
    const email = sequentialEmail(context, env)
    const result = await runDraftJobs({
      jobs,
      now,
      paidListings: ordersEnabledFor(env),
      priceCents: site.submissions.paidListingPriceCents,
      send: (templateId, request) => email.send(templateId, request)
    })
    return { ...result }
  }
}

/**
 * The badge program (#66): the same bounded run on its weekly, daily, and hourly triggers
 * (`lib/badge-program/program.ts`). While it is off it reads nothing and checks nothing.
 */
export function createBadgeProgramJob(features: SiteFeatures = siteFeatures): ScheduledJob {
  return {
    name: 'badge-program',
    async run({ context, env, now }) {
      if (!badgeProgramEnabled(env, features)) return { enabled: false }
      const operations = createBadgeProgramOperations({ client: createDatabase(database(env)) })
      const email = sequentialEmail(context, env)
      const result = await runBadgeProgram({
        now,
        operations,
        priceCents: site.submissions.paidListingPriceCents,
        send: (templateId, request) => email.send(templateId, request),
        verify: listing =>
          verifyFeaturedBadge(listing.website, submissionBadgeVerificationTargets(listing.slug))
      })
      return { enabled: true, ...result }
    }
  }
}

export const badgeProgramJob = createBadgeProgramJob()

/** Orders and refunds the sweep looks at per run. */
const BILLING_SWEEP_LIMIT = 50

/**
 * The billing sweep (#68, `runBillingSweep`): refunds still owed after an `other` rejection,
 * pending orders whose checkout closed (reconciled with the provider), and paid orders a crash
 * left unapplied. Off while orders are off.
 */
export function createBillingJob(features: SiteFeatures = siteFeatures): ScheduledJob {
  return {
    name: 'billing-sweep',
    async run({ context, env }) {
      if (!ordersEnabledFor(env, features)) return { enabled: false }
      const email = sequentialEmail(context, env)
      const deps = createBillingDependencies({
        env,
        notify: (templateId, request) => email.send(templateId, request)
      })
      return { enabled: true, ...(await runBillingSweep(deps, { limit: BILLING_SWEEP_LIMIT })) }
    }
  }
}

export const billingJob = createBillingJob()

/**
 * Retries the due listing and submission media slots and deletes finished submissions' images
 * (`runMediaCron`). Without a `DB` or `MEDIA` binding it logs `media_cron_disabled` and skips.
 */
export const mediaJobs: ScheduledJob = {
  name: 'listing-media',
  async run({ env }) {
    const summary = await runMediaCron(env)
    return summary ? { ...summary } : { disabled: true }
  }
}

export const scheduledJobs: Readonly<Record<string, readonly ScheduledJob[]>> = {
  [DRAFT_JOBS_CRON]: [draftJobs, badgeProgramJob, billingJob],
  [BADGE_WEEKLY_CRON]: [badgeProgramJob],
  [BADGE_DAILY_CRON]: [badgeProgramJob],
  [MEDIA_CRON]: [mediaJobs]
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
