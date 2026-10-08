/**
 * The email service: callers enqueue a template with an event key and a recipient, and the
 * service delivers it after the response through `waitUntil`.
 *
 * Delivery order (each step logs and stops on failure; nothing is ever thrown to the caller):
 *
 * 1. Validate the event key, the template id, and the recipient.
 * 2. Apply the environment policy (`./config.ts`): staging skips recipients that are not on
 *    its allowlist.
 * 3. Render the template, with links for this environment and the `[staging]` prefix.
 * 4. Claim the template and event key in the D1 ledger (`email_deliveries`). A pair that is
 *    in flight or already sent is a duplicate and is not sent again; a failed one may be
 *    retried by enqueueing it again. If the ledger cannot be reached, nothing is sent.
 * 5. Send once through the configured provider (no automatic retry), then record the outcome.
 *
 * Logs carry the event key and template id (only when well-formed; anything else is logged
 * as `[invalid]`), environment, provider, and the recipient's domain: never the full address
 * or the body (the local log sender is the one exception).
 */
import {
  EMAIL_EVENT_KEY_PATTERN,
  type EmailDeliveryClaim,
  type EmailDeliveryLedger,
  isEmailEventKey,
  isEmailTemplateId
} from '../../db/email-deliveries'
import {
  EMAIL_ADMIN_DASHBOARD_PATH,
  EMAIL_DASHBOARD_PATH,
  type EmailPolicy,
  normalizeEmailAddress,
  prefixedSubject,
  recipientAllowed,
  recipientDomain
} from './config'
import {
  type EmailSender,
  emailErrorCode,
  type OutgoingEmail,
  redactedErrorMessage
} from './senders'
import {
  createEmailLinks,
  type EmailRenderContext,
  type EmailTemplate,
  type EmailTemplateRegistry,
  type RenderedEmail,
  renderEmail,
  type TemplateInput
} from './templates'

export interface EmailLogEntry {
  [field: string]: unknown
  event: string
  level: 'error' | 'info' | 'warn'
}

export type EmailLogger = (entry: EmailLogEntry) => void

export const consoleEmailLogger: EmailLogger = ({ level, ...entry }) => {
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export interface EmailRequest<Input> {
  /**
   * Names the event occurrence this email reports, built with `emailEventKey`, for example
   * `emailEventKey('submission-created', submissionId)`. The same template and key never
   * send twice; different templates may share a key.
   */
  eventKey: string
  input: Input
  /** One recipient address. */
  to: string
}

export interface EmailService<R extends EmailTemplateRegistry> {
  /**
   * Schedules an email for delivery after the response (`waitUntil`). Returns immediately,
   * never throws, and never fails the caller's request; every outcome is logged.
   */
  enqueue<K extends keyof R & string>(
    templateId: K,
    request: EmailRequest<TemplateInput<R[K]>>
  ): void
}

export interface EmailServiceOptions<R extends EmailTemplateRegistry> {
  ledger: EmailDeliveryLedger
  log?: EmailLogger
  policy: EmailPolicy
  sender: EmailSender
  templates: R
  /** The request's (or cron event's) `ExecutionContext.waitUntil`. */
  waitUntil(promise: Promise<unknown>): void
}

const EVENT_KEY_PART = /^[a-z0-9][a-z0-9._-]*$/u

/**
 * An event key from an event name and the non-secret ids that identify one occurrence:
 * `emailEventKey('submission-created', id)` is `submission-created:<id>`. Parts are lower-case
 * letters, digits, `.`, `_`, and `-`, so an address can never become a key. Keys are logged
 * and kept in D1: never derive one from a secret such as a sign-in code. A code email is a new
 * event on every call, so key it per call: `emailEventKey('sign-in-code', crypto.randomUUID())`
 * (Better Auth's `sendVerificationOTP` gets only `{ email, otp, type }`), or use an HMAC under
 * a Worker secret. To send one event to several recipients with the same template, add a
 * recipient id (a user id, never the address).
 */
export function emailEventKey(event: string, ...ids: string[]): string {
  const parts = [event, ...ids]
  if (ids.length === 0 || parts.some(part => !EVENT_KEY_PART.test(part))) {
    throw new Error('Email event keys take an event name and ids of [a-z0-9._-].')
  }
  const key = parts.join(':')
  if (!EMAIL_EVENT_KEY_PATTERN.test(key)) throw new Error('Email event key is too long.')
  return key
}

/**
 * The context a template renders with: this environment's links, the recipient, and the
 * footer's dashboard link: the template's own `footerPath` for this input, else its audience's
 * dashboard (the user dashboard, or the admin one).
 */
export function emailRenderContext<Input>(
  policy: EmailPolicy,
  template: Pick<EmailTemplate<Input>, 'audience' | 'footerPath'>,
  recipient: string,
  input: Input
): EmailRenderContext {
  const links = createEmailLinks(policy.linkOrigin)
  const footerPath = template.footerPath
    ? template.footerPath(input)
    : template.audience === 'admin'
      ? EMAIL_ADMIN_DASHBOARD_PATH
      : EMAIL_DASHBOARD_PATH
  return {
    dashboardUrl: links.url(footerPath),
    environment: policy.environment,
    links,
    recipient
  }
}

const INVALID = '[invalid]'
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

/**
 * The provider idempotency key for one environment, template, and event key: the same for every
 * attempt, so a retry after a lost response is answered with the original message instead of a
 * second one. `<environment>:<template id>:<event key>`, or its SHA-256 when that would exceed
 * 256 characters. useSend keeps idempotency keys per team, and staging and production share a
 * team while their ids overlap (imported listings, autoincrement rows), so the environment is
 * part of the key; without it a staging send would make production's 409 for 24 hours.
 */
export async function emailIdempotencyKey(
  environment: string,
  templateId: string,
  eventKey: string
): Promise<string> {
  const key = `${environment}:${templateId}:${eventKey}`
  if (key.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return key
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

/**
 * The fields every log line starts with. The event key and template id appear only when they
 * are well-formed, so a malformed one (an address passed as a key) never reaches a log.
 */
export function emailLogContext(
  templateId: unknown,
  request: unknown,
  fields: Record<string, unknown>
): Record<string, unknown> {
  let eventKey: unknown
  try {
    eventKey =
      typeof request === 'object' && request !== null && 'eventKey' in request
        ? request.eventKey
        : undefined
  } catch {
    eventKey = undefined
  }
  return {
    ...fields,
    eventKey: isEmailEventKey(eventKey) ? eventKey : INVALID,
    templateId: isEmailTemplateId(templateId) ? templateId : INVALID
  }
}

export function createEmailService<R extends EmailTemplateRegistry>(
  options: EmailServiceOptions<R>
): EmailService<R> {
  const { ledger, policy, sender, templates } = options
  const log = options.log ?? consoleEmailLogger
  const provider = sender.provider

  async function deliver(
    templateId: string,
    request: Partial<EmailRequest<unknown>>,
    context: Record<string, unknown>
  ): Promise<void> {
    const eventKey = request.eventKey
    if (!isEmailEventKey(eventKey)) {
      log({ ...context, event: 'email_rejected', level: 'error', reason: 'invalid_event_key' })
      return
    }
    // Templates declare `render` as a method, so any registered template accepts `unknown`
    // here; the caller's input type was already checked by `enqueue`'s signature.
    const template: EmailTemplate<unknown> | undefined =
      isEmailTemplateId(templateId) && Object.hasOwn(templates, templateId)
        ? templates[templateId]
        : undefined
    if (!template) {
      log({ ...context, event: 'email_rejected', level: 'error', reason: 'unknown_template' })
      return
    }
    const to = normalizeEmailAddress(request.to)
    if (!to) {
      log({ ...context, event: 'email_rejected', level: 'error', reason: 'invalid_recipient' })
      return
    }
    const recipient = { ...context, recipientDomain: recipientDomain(to) }
    if (!recipientAllowed(policy, to)) {
      log({ ...recipient, event: 'email_skipped', level: 'warn', reason: 'recipient_not_allowed' })
      return
    }

    let rendered: RenderedEmail
    try {
      rendered = renderEmail(
        template,
        request.input,
        emailRenderContext(policy, template, to, request.input)
      )
    } catch (error) {
      log({
        ...recipient,
        error: redactedErrorMessage(error),
        event: 'email_render_failed',
        level: 'error'
      })
      return
    }

    const idempotencyKey = await emailIdempotencyKey(policy.environment, templateId, eventKey)
    let claim: EmailDeliveryClaim
    try {
      claim = await ledger.claim({ eventKey, provider, templateId })
    } catch (error) {
      log({
        ...recipient,
        error: redactedErrorMessage(error),
        event: 'email_ledger_failed',
        level: 'error',
        stage: 'claim'
      })
      return
    }
    if (claim.outcome === 'duplicate') {
      log(
        claim.exhausted
          ? {
              ...recipient,
              attempts: claim.attempts,
              event: 'email_attempts_exhausted',
              level: 'warn'
            }
          : {
              ...recipient,
              attempts: claim.attempts,
              event: 'email_duplicate_suppressed',
              level: 'info',
              status: claim.status
            }
      )
      return
    }

    const message: OutgoingEmail = {
      from: { ...policy.from },
      headers: { 'Auto-Submitted': 'auto-generated' },
      html: rendered.html,
      idempotencyKey,
      subject: prefixedSubject(policy, rendered.subject),
      text: rendered.text,
      to
    }
    const attempt = { ...recipient, attempt: claim.attempt }
    let outcome: { errorCode: string | null; messageId: string | null; status: 'failed' | 'sent' }
    try {
      const receipt = await sender.send(message)
      outcome = { errorCode: null, messageId: receipt.messageId, status: 'sent' }
      log({ ...attempt, event: 'email_sent', level: 'info', messageId: receipt.messageId })
    } catch (error) {
      outcome = { errorCode: emailErrorCode(error), messageId: null, status: 'failed' }
      log({
        ...attempt,
        error: redactedErrorMessage(error),
        errorCode: outcome.errorCode,
        event: 'email_send_failed',
        level: 'error'
      })
    }

    try {
      const recorded = await ledger.complete({
        attempt: claim.attempt,
        errorCode: outcome.errorCode,
        eventKey,
        providerMessageId: outcome.messageId,
        status: outcome.status,
        templateId
      })
      if (!recorded) {
        log({ ...attempt, event: 'email_ledger_failed', level: 'warn', stage: 'complete_stale' })
      }
    } catch (error) {
      // A sent email whose outcome cannot be recorded stays `sending`, so it is never resent.
      log({
        ...attempt,
        error: redactedErrorMessage(error),
        event: 'email_ledger_failed',
        level: 'error',
        stage: 'complete'
      })
    }
  }

  return {
    enqueue(templateId, request) {
      const context = emailLogContext(templateId, request, {
        environment: policy.environment,
        provider
      })
      try {
        // `deliver` is async, so even a malformed request becomes a rejection logged here.
        const delivery = deliver(templateId, request ?? {}, context).catch(error => {
          log({
            ...context,
            error: redactedErrorMessage(error),
            event: 'email_delivery_failed',
            level: 'error'
          })
        })
        options.waitUntil(delivery)
      } catch (error) {
        log({
          ...context,
          error: redactedErrorMessage(error),
          event: 'email_wait_until_failed',
          level: 'error'
        })
      }
    }
  }
}

/**
 * A service that sends nothing and logs every enqueue: what the Worker gets when its email
 * configuration is invalid (fail closed).
 */
export function createDisabledEmailService<R extends EmailTemplateRegistry>(
  reason: string,
  log: EmailLogger = consoleEmailLogger
): EmailService<R> {
  return {
    enqueue(templateId, request) {
      log({
        ...emailLogContext(templateId, request, { reason: redactedErrorMessage(reason) }),
        event: 'email_disabled',
        level: 'error'
      })
    }
  }
}
