/**
 * Builds the email service from Worker bindings. Route handlers reach it through
 * `./server.ts`; a Worker handler outside Next.js (the badge cron, #66) calls
 * `createWorkerEmailService` with its own `env` and `ExecutionContext`.
 *
 * Fails closed: an unknown environment, a missing `DB` binding, or (in staging and production)
 * a missing or invalid `USESEND_BASE_URL` var or `USESEND_API_KEY` secret yields a service that
 * sends nothing and logs `email_disabled` on every enqueue. Local never sends, even with a key.
 */
import { createDatabase } from '@serpdirectory/data-ops/client'
import { createEmailDeliveryLedger } from '@serpdirectory/data-ops/email-deliveries'
import {
  EmailConfigError,
  type EmailEnvironmentVars,
  type EmailPolicy,
  resolveEmailPolicy,
  resolveUseSendConfig,
  type UseSendConfig
} from './config'
import { createLogEmailSender, createUseSendSender } from './senders'
import {
  consoleEmailLogger,
  createDisabledEmailService,
  createEmailService,
  type EmailLogger,
  type EmailService
} from './service'
import type { EmailTemplateRegistry } from './templates'

export interface EmailWorkerEnv extends EmailEnvironmentVars {
  DB?: D1Database
  /** Worker secret (staging, production). */
  USESEND_API_KEY?: string
  /** Worker var: the useSend instance origin, `https://app.usesend.com`. */
  USESEND_BASE_URL?: string
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void
}

interface WorkerDelivery {
  database: D1Database
  policy: EmailPolicy
  /** Staging and production: where and how to call useSend. Local logs instead. */
  useSend: UseSendConfig | null
}

/** What `env` delivers with, or an `EmailConfigError` naming why email is disabled. */
function resolveWorkerDelivery(env: EmailWorkerEnv): WorkerDelivery {
  const policy = resolveEmailPolicy(env)
  if (!env.DB) throw new EmailConfigError('Email is disabled: the D1 binding DB is required.')
  return {
    database: env.DB,
    policy,
    useSend: policy.delivery === 'provider' ? resolveUseSendConfig(env) : null
  }
}

/**
 * True when `createWorkerEmailService(env)` would deliver mail instead of disabling itself: the
 * environment vars agree, the `DB` binding is present, and staging and production have a valid
 * `USESEND_BASE_URL` and `USESEND_API_KEY`. It sends nothing and queries nothing, so a caller
 * can check it before creating something only an email can deliver (a sign-in code).
 * Recipient rules are separate: staging still skips addresses outside its allowlist.
 */
export function isEmailDeliveryConfigured(env: EmailWorkerEnv): boolean {
  try {
    resolveWorkerDelivery(env)
    return true
  } catch {
    return false
  }
}

export function createWorkerEmailService<R extends EmailTemplateRegistry>(options: {
  clock?: () => Date
  context: WaitUntilContext
  env: EmailWorkerEnv
  /** The `fetch` the useSend sender uses (tests inject one). */
  fetch?: typeof fetch
  log?: EmailLogger
  templates: R
}): EmailService<R> {
  const { context, env, templates } = options
  const log = options.log ?? consoleEmailLogger
  try {
    const { database, policy, useSend } = resolveWorkerDelivery(env)
    const sender = useSend
      ? createUseSendSender({ ...useSend, fetch: options.fetch })
      : // Local only (`useSend` is null): log, and keep messages for the dev outbox endpoint.
        createLogEmailSender(undefined, { devOutbox: policy.environment === 'local' })
    return createEmailService({
      ledger: createEmailDeliveryLedger({ client: createDatabase(database), clock: options.clock }),
      log,
      policy,
      sender,
      templates,
      waitUntil: promise => context.waitUntil(promise)
    })
  } catch (error) {
    const reason =
      error instanceof EmailConfigError ? error.message : 'Email is disabled: configuration failed.'
    return createDisabledEmailService(reason, log)
  }
}
