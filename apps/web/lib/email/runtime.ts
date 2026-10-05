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
  resolveEmailPolicy,
  resolveUseSendConfig
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
    const policy = resolveEmailPolicy(env)
    if (!env.DB) throw new EmailConfigError('Email is disabled: the D1 binding DB is required.')
    const sender =
      policy.delivery === 'provider'
        ? createUseSendSender({ ...resolveUseSendConfig(env), fetch: options.fetch })
        : createLogEmailSender()
    return createEmailService({
      ledger: createEmailDeliveryLedger({ client: createDatabase(env.DB), clock: options.clock }),
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
