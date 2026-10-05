/**
 * Delivery of sign-in codes (serpcompany/best.serp.co#60). Better Auth's email OTP plugin hands
 * every code to an `OtpSender`:
 *
 * - `local`: the dev sender logs the code and keeps the latest code per email in an in-memory
 *   outbox, which the local-only `/api/auth/dev/otp-outbox` endpoint returns to tests. Local
 *   `wrangler dev` runs one isolate, so the outbox is shared by every request.
 * - `staging`, `production`: the email sender enqueues the `sign-in-code` email through the
 *   email module (`lib/email`, #61), keyed `emailEventKey('sign-in-code', crypto.randomUUID())`
 *   because every code is a new event and a key must never derive from the code. Until that
 *   template is registered, no sender is configured: requesting a code fails with 503
 *   `OTP_DELIVERY_UNAVAILABLE` and no code is created, logged, or exposed.
 */
import type { SiteEnvironment } from '../environment/site-environment'

/** The email template that carries a sign-in code (`lib/email/registry.ts`, #61). */
export const SIGN_IN_CODE_TEMPLATE_ID = 'sign-in-code'

/** What the `sign-in-code` template renders: the code and how long it lasts. */
export interface SignInCodeEmailInput {
  code: string
  expiresInMinutes: number
}

/** Enqueues one `sign-in-code` email (`enqueueEmail`, which never throws). */
export type SignInCodeEnqueue = (request: {
  eventKey: string
  input: SignInCodeEmailInput
  to: string
}) => Promise<void>

/** How staging and production deliver codes, from `lib/auth/sign-in-code-email.ts`. */
export interface SignInCodeEmail {
  enqueue: SignInCodeEnqueue
  /** A new event key per code: `emailEventKey('sign-in-code', crypto.randomUUID())`. */
  eventKey(): string
  /** False until the `sign-in-code` template is in the email registry. */
  templateRegistered: boolean
}

export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'

export interface OtpMessage {
  email: string
  expiresInSeconds: number
  otp: string
  purpose: OtpPurpose
}

export interface OtpSender {
  /** `dev-console` exposes codes to local tests; it must never run outside local. */
  readonly kind: 'dev-console' | 'unavailable' | (string & {})
  send(message: OtpMessage): Promise<void>
}

export class OtpDeliveryUnavailableError extends Error {
  constructor() {
    super('Sign-in code delivery is not configured for this environment.')
    this.name = 'OtpDeliveryUnavailableError'
  }
}

interface OutboxEntry {
  otp: string
  sentAt: number
}

const OUTBOX_KEY = Symbol.for('best.serp.co/dev-otp-outbox')

function outbox(): Map<string, OutboxEntry> {
  const scope = globalThis as typeof globalThis & { [OUTBOX_KEY]?: Map<string, OutboxEntry> }
  scope[OUTBOX_KEY] ||= new Map()
  return scope[OUTBOX_KEY]
}

/**
 * The latest code the dev sender delivered to `email` within its lifetime and when (epoch
 * milliseconds), or null. `sentAt` tells a test whether its request sent a code at all: a
 * request a per-email limit denies answers like a sent one.
 */
export function readDevOtpOutbox(
  email: string,
  now = Date.now()
): { otp: string; sentAt: number } | null {
  const entry = outbox().get(email.trim().toLowerCase())
  if (!entry) return null
  return now - entry.sentAt <= 15 * 60 * 1000 ? { otp: entry.otp, sentAt: entry.sentAt } : null
}

export function clearDevOtpOutbox(): void {
  outbox().clear()
}

export function createDevOtpSender(log: (line: string) => void = console.info): OtpSender {
  return {
    kind: 'dev-console',
    async send(message) {
      const email = message.email.trim().toLowerCase()
      outbox().set(email, { otp: message.otp, sentAt: Date.now() })
      log(
        JSON.stringify({
          event: 'dev_otp_sent',
          email,
          otp: message.otp,
          purpose: message.purpose
        })
      )
    }
  }
}

export const unavailableOtpSender: OtpSender = {
  kind: 'unavailable',
  async send() {
    throw new OtpDeliveryUnavailableError()
  }
}

/** Sends sign-in codes as the `sign-in-code` email. */
export function createEmailOtpSender({
  enqueue,
  eventKey
}: Pick<SignInCodeEmail, 'enqueue' | 'eventKey'>): OtpSender {
  return {
    kind: 'email',
    async send(message) {
      if (message.purpose !== 'sign-in') throw new OtpDeliveryUnavailableError()
      await enqueue({
        eventKey: eventKey(),
        input: {
          code: message.otp,
          expiresInMinutes: Math.round(message.expiresInSeconds / 60)
        },
        to: message.email
      })
    }
  }
}

/**
 * The sender for an environment: the dev sender locally (it is refused anywhere else), and in
 * staging and production the email sender once the `sign-in-code` template is registered.
 */
export function selectOtpSender(environment: SiteEnvironment, email?: SignInCodeEmail): OtpSender {
  if (environment === 'local') return createDevOtpSender()
  return email?.templateRegistered ? createEmailOtpSender(email) : unavailableOtpSender
}
