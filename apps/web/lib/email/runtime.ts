/**
 * Builds the email service from Worker bindings. Route handlers reach it through
 * `./server.ts`; a Worker handler outside Next.js (the badge cron, #66) calls
 * `createWorkerEmailService` with its own `env` and `ExecutionContext`.
 *
 * Fails closed: an unknown environment, a missing `DB` binding, or (in staging and production)
 * a missing `EMAIL` binding yields a service that sends nothing and logs `email_disabled` on
 * every enqueue. Local never sends, even with an `EMAIL` binding.
 */
import { createDatabase } from '@serpdirectory/data-ops/client'
import { createEmailDeliveryLedger } from '@serpdirectory/data-ops/email-deliveries'
import { EmailConfigError, type EmailEnvironmentVars, resolveEmailPolicy } from './config'
import { createCloudflareEmailSender, createLogEmailSender, type SendEmailBinding } from './senders'
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
  EMAIL?: SendEmailBinding
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void
}

export function createWorkerEmailService<R extends EmailTemplateRegistry>(options: {
  clock?: () => Date
  context: WaitUntilContext
  env: EmailWorkerEnv
  log?: EmailLogger
  templates: R
}): EmailService<R> {
  const { context, env, templates } = options
  const log = options.log ?? consoleEmailLogger
  try {
    const policy = resolveEmailPolicy(env)
    if (!env.DB) throw new EmailConfigError('Email is disabled: the D1 binding DB is required.')
    let sender = createLogEmailSender()
    if (policy.delivery === 'provider') {
      if (!env.EMAIL) {
        throw new EmailConfigError(
          `Email is disabled: the EMAIL send_email binding is required in ${policy.environment}.`
        )
      }
      sender = createCloudflareEmailSender(env.EMAIL)
    }
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
