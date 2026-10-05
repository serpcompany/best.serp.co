/**
 * Delivery of sign-in codes (serpcompany/best.serp.co#60). Better Auth's email OTP plugin hands
 * every code to an `OtpSender`. Real email (Cloudflare Email Sending from noreply@mail.serp.co)
 * is serpcompany/best.serp.co#61; until it lands, only local development can deliver codes:
 *
 * - `local`: the dev sender logs the code and keeps the latest code per email in an in-memory
 *   outbox, which the local-only `/api/auth/dev/otp-outbox` endpoint returns to tests. Local
 *   `wrangler dev` runs one isolate, so the outbox is shared by every request.
 * - `staging`, `production`: no sender is configured, so requesting a code fails with 503 and
 *   no code is ever logged or exposed.
 */
import type { SiteEnvironment } from '../environment/site-environment'

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

/** The latest code the dev sender delivered to `email` within its lifetime, or null. */
export function readDevOtpOutbox(email: string, now = Date.now()): string | null {
  const entry = outbox().get(email.trim().toLowerCase())
  if (!entry) return null
  return now - entry.sentAt <= 15 * 60 * 1000 ? entry.otp : null
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
 * The sender for an environment. #61 adds the email sender for staging and production here;
 * the dev sender is refused anywhere but local.
 */
export function selectOtpSender(environment: SiteEnvironment): OtpSender {
  return environment === 'local' ? createDevOtpSender() : unavailableOtpSender
}
