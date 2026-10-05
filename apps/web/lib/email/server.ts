import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { type AppEmailTemplates, appEmailTemplates } from './registry'
import { createWorkerEmailService } from './runtime'
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

export { EMAIL_ADMIN_RECIPIENT } from './config'
export { SIGN_IN_CODE_LENGTH, SIGN_IN_CODE_TTL_SECONDS } from './emails/codes'
export { SIGN_IN_CODE_TEMPLATE } from './registry'
export { emailEventKey } from './service'
