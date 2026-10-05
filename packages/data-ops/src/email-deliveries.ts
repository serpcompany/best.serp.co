import { and, eq, lt, sql } from 'drizzle-orm'
import type { CompiledQuery, Database } from './client'
import { emailDeliveries } from './schema'

/**
 * The idempotency ledger behind transactional email (`apps/web/lib/email/`).
 *
 * Every send names a template and an event key (for example `submission-received` and
 * `submission-created:<submission id>`). Before sending, the caller claims that pair with one
 * atomic upsert; only the claim that inserts the row, or re-claims a `failed` one, may send.
 * A pair whose send is in flight (`sending`) or done (`sent`) is a duplicate, so a retried
 * request, a re-run cron, or a double submit never sends the same email twice. One event may
 * still send several templates (the submitter's receipt and the admin notice). A `sending`
 * row is never re-claimed automatically: its outcome is unknown, and a missed email is
 * preferred over a duplicate one.
 *
 * Rows hold no recipient, subject, or body. Event keys may not contain `@`, so an address
 * cannot be used as one (the table's CHECK enforces it too). Timestamps use SQLite's
 * `YYYY-MM-DD HH:MM:SS` (UTC), like `CURRENT_TIMESTAMP`, so `datetime('now', ...)`
 * comparisons work.
 */

export const EMAIL_DELIVERY_MAX_ATTEMPTS = 5
export const EMAIL_EVENT_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{2,199}$/u
export const EMAIL_TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const MESSAGE_ID_MAX_LENGTH = 256

export type EmailDeliveryStatus = 'failed' | 'sending' | 'sent'

export type EmailDeliveryClaim =
  | { attempt: number; outcome: 'claimed' }
  | {
      attempts: number
      /** A `failed` row that used up its attempts; it is never sent again. */
      exhausted: boolean
      outcome: 'duplicate'
      status: EmailDeliveryStatus
    }

export interface EmailDeliveryClaimInput {
  eventKey: string
  provider: string
  templateId: string
}

export interface EmailDeliveryCompletion {
  attempt: number
  errorCode?: string | null
  eventKey: string
  providerMessageId?: string | null
  status: 'failed' | 'sent'
  templateId: string
}

export interface EmailDeliveryLedger {
  /** Atomically claims a template and event key for one send attempt. */
  claim(input: EmailDeliveryClaimInput): Promise<EmailDeliveryClaim>
  /**
   * Records the outcome of a claimed attempt. Returns false when the row no longer holds that
   * attempt (it was never claimed, or a later attempt replaced it); nothing is changed then.
   */
  complete(input: EmailDeliveryCompletion): Promise<boolean>
}

export function isEmailEventKey(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_EVENT_KEY_PATTERN.test(value)
}

export function isEmailTemplateId(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_TEMPLATE_ID_PATTERN.test(value)
}

/** `YYYY-MM-DD HH:MM:SS` in UTC, the format of SQLite's `CURRENT_TIMESTAMP`. */
export function sqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid email delivery ${label}.`)
  return value
}

function prepare(client: Database, query: CompiledQuery): D1PreparedStatement {
  const compiled = query.toSQL()
  return client.binding.prepare(compiled.sql).bind(...compiled.params)
}

export function createEmailDeliveryLedger(config: {
  client: Database
  clock?: () => Date
}): EmailDeliveryLedger {
  const { client } = config
  const clock = config.clock ?? (() => new Date())
  const now = () => sqliteTimestamp(clock())

  return {
    async claim(input) {
      const eventKey = requirePattern(input.eventKey, EMAIL_EVENT_KEY_PATTERN, 'event key')
      const templateId = requirePattern(input.templateId, EMAIL_TEMPLATE_ID_PATTERN, 'template id')
      const provider = requirePattern(input.provider, PROVIDER_PATTERN, 'provider')
      const timestamp = now()
      const claimed = await prepare(
        client,
        client.database
          .insert(emailDeliveries)
          .values({
            attempts: 1,
            createdAt: timestamp,
            eventKey,
            provider,
            status: 'sending',
            templateId,
            updatedAt: timestamp
          })
          .onConflictDoUpdate({
            set: {
              attempts: sql`${emailDeliveries.attempts} + 1`,
              lastErrorCode: null,
              provider,
              providerMessageId: null,
              status: 'sending',
              updatedAt: timestamp
            },
            setWhere: and(
              eq(emailDeliveries.status, 'failed'),
              lt(emailDeliveries.attempts, EMAIL_DELIVERY_MAX_ATTEMPTS)
            ),
            target: [emailDeliveries.templateId, emailDeliveries.eventKey]
          })
          .returning({ attempts: emailDeliveries.attempts })
      ).all<{ attempts: number }>()
      const attempt = claimed.results[0]?.attempts
      if (typeof attempt === 'number') return { attempt, outcome: 'claimed' }

      const existing = await prepare(
        client,
        client.database
          .select({ attempts: emailDeliveries.attempts, status: emailDeliveries.status })
          .from(emailDeliveries)
          .where(
            and(eq(emailDeliveries.templateId, templateId), eq(emailDeliveries.eventKey, eventKey))
          )
          .limit(1)
      ).first<{ attempts: number; status: EmailDeliveryStatus }>()
      if (!existing) throw new Error('Email delivery claim neither inserted nor found its row.')
      return {
        attempts: existing.attempts,
        // A failed row is re-claimed until it reaches the limit, so a failed duplicate is done.
        exhausted: existing.status === 'failed',
        outcome: 'duplicate',
        status: existing.status
      }
    },

    async complete(input) {
      const eventKey = requirePattern(input.eventKey, EMAIL_EVENT_KEY_PATTERN, 'event key')
      const templateId = requirePattern(input.templateId, EMAIL_TEMPLATE_ID_PATTERN, 'template id')
      if (!Number.isInteger(input.attempt) || input.attempt < 1) {
        throw new Error('Invalid email delivery attempt.')
      }
      const errorCode =
        input.status === 'failed'
          ? ERROR_CODE_PATTERN.test(input.errorCode ?? '')
            ? (input.errorCode ?? null)
            : 'E_UNKNOWN'
          : null
      const providerMessageId =
        input.status === 'sent' && input.providerMessageId
          ? input.providerMessageId.slice(0, MESSAGE_ID_MAX_LENGTH)
          : null
      const updated = await prepare(
        client,
        client.database
          .update(emailDeliveries)
          .set({
            lastErrorCode: errorCode,
            providerMessageId,
            status: input.status,
            updatedAt: now()
          })
          .where(
            and(
              eq(emailDeliveries.templateId, templateId),
              eq(emailDeliveries.eventKey, eventKey),
              eq(emailDeliveries.status, 'sending'),
              eq(emailDeliveries.attempts, input.attempt)
            )
          )
          .returning({ eventKey: emailDeliveries.eventKey })
      ).all<{ eventKey: string }>()
      return updated.results.length === 1
    }
  }
}
