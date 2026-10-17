import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { type AppEmailTemplates, appEmailTemplates } from './registry'
import { createWorkerEmailService, isEmailDeliveryConfigured } from './runtime'
import { redactedErrorMessage } from './senders'
import {
  consoleEmailLogger,
  type EmailDeliveryOutcome,
  type EmailRequest,
  type EmailService,
  emailLogContext
} from './service'
import type { TemplateInput } from './templates'

type AppEmailRequest<K extends keyof AppEmailTemplates> = EmailRequest<
  TemplateInput<AppEmailTemplates[K]>
>

/** This request's email service, or null (logged) when its Cloudflare context is unavailable. */
async function requestEmailService(
  templateId: string,
  request: unknown
): Promise<EmailService<AppEmailTemplates> | null> {
  try {
    const { ctx, env } = await getCloudflareContext({ async: true })
    return createWorkerEmailService({ context: ctx, env, templates: appEmailTemplates })
  } catch (error) {
    consoleEmailLogger({
      ...emailLogContext(templateId, request, { error: redactedErrorMessage(error) }),
      event: 'email_context_unavailable',
      level: 'error'
    })
    return null
  }
}

/**
 * Enqueues one of the site's emails from a route handler, server action, or server component.
 * The email is delivered after the response through the request's `ctx.waitUntil`, at most
 * once per template and event key. Resolves once it is scheduled; never rejects and never fails the
 * request, because every outcome (including a missing binding) is logged instead.
 *
 * ```ts
 * await enqueueEmail('<template id>', {
 *   eventKey: emailEventKey('<event name>', occurrenceId),
 *   input: templateInput,
 *   to: recipientAddress
 * })
 * ```
 */
export async function enqueueEmail<K extends keyof AppEmailTemplates & string>(
  templateId: K,
  request: AppEmailRequest<K>
): Promise<void> {
  const service = await requestEmailService(templateId, request)
  service?.enqueue(templateId, request)
}

/**
 * `enqueueEmail`, resolving once delivery finishes with what it did (`EmailDeliveryOutcome`),
 * for a caller that reports it: an admin decision answers it to the admin (#490). Never rejects.
 */
export async function deliverEmail<K extends keyof AppEmailTemplates & string>(
  templateId: K,
  request: AppEmailRequest<K>
): Promise<EmailDeliveryOutcome> {
  const service = await requestEmailService(templateId, request)
  return service ? service.deliver(templateId, request) : 'not_sent'
}

/**
 * Whether this request's Worker can deliver email (`isEmailDeliveryConfigured`). False, never
 * a rejection, when the Cloudflare context is unavailable. Better Auth checks it before
 * creating a sign-in code, so a code is never created without a way to send it.
 */
export async function emailDeliveryConfigured(): Promise<boolean> {
  try {
    const { env } = await getCloudflareContext({ async: true })
    return isEmailDeliveryConfigured(env)
  } catch {
    return false
  }
}

export { EMAIL_ADMIN_RECIPIENT } from './config'
export { emailEventKey } from './service'
