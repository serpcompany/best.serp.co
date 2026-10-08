/**
 * Delivery of sign-in codes (serpcompany/best.serp.co#60). Better Auth's email OTP plugin hands
 * every code to an `OtpSender`:
 *
 * - `local`: the dev sender logs the code and keeps the latest code per email in an in-memory
 *   outbox, which the local-only `/api/auth/dev/otp-outbox` endpoint returns to tests. Local
 *   `wrangler dev` runs one isolate, so the outbox is shared by every request.
 * - `staging`, `production`: the email sender enqueues the `sign-in-code` email through the
 *   email module (`lib/email`, #61), keyed `emailEventKey('sign-in-code', crypto.randomUUID())`
 *   because every code is a new event and a key must never derive from the code. Without a
 *   registered template, no sender is configured; and before each code, the sender checks
 *   that the Worker can deliver email at all (`emailDeliveryConfigured`: the environment, the
 *   `DB` binding, and the useSend key and base URL). Either way, requesting a code fails with
 *   503 `OTP_DELIVERY_UNAVAILABLE` and no code is created, logged, or exposed.
 */
import { SIGN_IN_CODE_TEMPLATE, type SignInCodeInput } from '../email/sign-in-code'
import type { SiteEnvironment } from '../environment/site-environment'

/** The email template that carries a sign-in code (`lib/email/sign-in-code.ts`, #61). */
export const SIGN_IN_CODE_TEMPLATE_ID = SIGN_IN_CODE_TEMPLATE

/** What the `sign-in-code` template renders: the code and how long it lasts. */
export type SignInCodeEmailInput = SignInCodeInput

/** Enqueues one `sign-in-code` email (`enqueueEmail`, which never throws). */
export type SignInCodeEnqueue = (request: {
  eventKey: string
  input: SignInCodeEmailInput
  to: string
}) => Promise<void>

/** How staging and production deliver codes, from `lib/auth/sign-in-code-email.ts`. */
export interface SignInCodeEmail {
  /**
   * Whether this request's Worker can deliver email (`emailDeliveryConfigured` in
   * `lib/email/server.ts`); checked before every code is created. Resolves false on any doubt.
   */
  deliveryConfigured(): Promise<boolean>
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
  /**
   * Checked at request time, before a code exists: false refuses the request with 503
   * `OTP_DELIVERY_UNAVAILABLE`. A sender without it is always ready.
   */
  deliveryConfigured?(): Promise<boolean>
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

/**
 * True when `sender` can deliver a code now. The `unavailable` sender never can, and a failed
 * check counts as no (fail closed).
 */
export async function otpDeliveryReady(sender: OtpSender): Promise<boolean> {
  if (sender.kind === 'unavailable') return false
  if (!sender.deliveryConfigured) return true
  try {
    return (await sender.deliveryConfigured()) === true
  } catch {
    return false
  }
}

/** Sends sign-in codes as the `sign-in-code` email, once the Worker can deliver email. */
export function createEmailOtpSender({
  deliveryConfigured,
  enqueue,
  eventKey
}: Pick<SignInCodeEmail, 'deliveryConfigured' | 'enqueue' | 'eventKey'>): OtpSender {
  return {
    deliveryConfigured,
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
