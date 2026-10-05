import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { type AppEmailTemplates, appEmailTemplates } from './registry'
import { createWorkerEmailService } from './runtime'
import type { EmailRequest } from './service'
import type { TemplateInput } from './templates'

/**
 * Enqueues one of the site's emails from a route handler, server action, or server component.
 * The email is delivered after the response through the request's `ctx.waitUntil`, at most
 * once per event key. Resolves once it is scheduled; never rejects and never fails the
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
    console.error(
      JSON.stringify({
        event: 'email_context_unavailable',
        message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
        templateId
      })
    )
  }
}

export { emailEventKey } from './service'
