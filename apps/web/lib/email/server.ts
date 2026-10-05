import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { type AppEmailTemplates, appEmailTemplates } from './registry'
import { createWorkerEmailService, isEmailDeliveryConfigured } from './runtime'
import { redactedErrorMessage } from './senders'
import { consoleEmailLogger, type EmailRequest, emailLogContext } from './service'
import type { TemplateInput } from './templates'

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
  request: EmailRequest<TemplateInput<AppEmailTemplates[K]>>
): Promise<void> {
  try {
    const { ctx, env } = await getCloudflareContext({ async: true })
    createWorkerEmailService({
      context: ctx,
      env,
      templates: appEmailTemplates
    }).enqueue(templateId, request)
  } catch (error) {
    consoleEmailLogger({
      ...emailLogContext(templateId, request, { error: redactedErrorMessage(error) }),
      event: 'email_context_unavailable',
      level: 'error'
    })
  }
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
