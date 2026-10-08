/**
 * Email providers behind one interface, so the provider can change without touching callers
 * or templates:
 *
 * - `createUseSendSender`: useSend's send-email API (SES-backed), staging and production.
 *   https://docs.usesend.com/api-reference/emails/send-email
 * - `createLogEmailSender`: writes each message to the Worker log; local development only.
 *   With `devOutbox`, it also keeps recent messages in memory for the local-only
 *   `/api/dev/email-outbox` endpoint that end-to-end tests read (`readDevEmailOutbox`).
 * - `createCapturingEmailSender`: records messages in memory for tests.
 */

export interface EmailSenderAddress {
  email: string
  name: string
}

export interface OutgoingEmail {
  from: EmailSenderAddress
  headers: Readonly<Record<string, string>>
  html: string
  /**
   * Stable for one template and event key across attempts, so a provider that supports
   * idempotency keys (useSend) never sends a retried message twice.
   */
  idempotencyKey: string
  subject: string
  text: string
  /** One recipient, already validated and normalized. */
  to: string
}

export interface EmailSendReceipt {
  /** The provider's message id, when it returns one. */
  messageId: string | null
}

export interface EmailSender {
  /** Recorded with each delivery: `usesend`, `log`, or `capture`. */
  readonly provider: string
  /** Resolves once the provider accepted the message; rejects when it did not. */
  send(message: OutgoingEmail): Promise<EmailSendReceipt>
}

/** A provider refusal with a stable code for logs and the ledger (`RATE_LIMITED`, ...). */
export class EmailProviderError extends Error {
  override name = 'EmailProviderError'

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** `Name <address>`; site-config names are plain words, so no quoting is needed. */
export function formatSender(from: EmailSenderAddress): string {
  return `${from.name} <${from.email}>`
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const DEFAULT_USESEND_TIMEOUT_MS = 10_000

function useSendErrorCode(body: unknown, status: number): string {
  const code =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error
      ? body.error.code
      : undefined
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : `HTTP_${status}`
}

const TOKEN_IN_TEXT = /\bBearer\s+\S+|\bus_[A-Za-z0-9_-]+/giu

/** Text with the API key, any `Bearer …` credential, and `us_…` tokens replaced. */
export function scrubSecrets(text: string, apiKey?: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join('[redacted]') : text
  return withoutKey.replace(TOKEN_IN_TEXT, '[redacted]')
}

function useSendErrorMessage(body: unknown): string {
  const message =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'message' in body.error
      ? body.error.message
      : undefined
  return typeof message === 'string' ? message.slice(0, 200) : ''
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * useSend's `POST {baseUrl}/api/v1/emails` with `Authorization: Bearer <key>` and an
 * `Idempotency-Key`: useSend returns the original `emailId` for a repeated key and body for
 * 24 hours, on top of this module's ledger. Errors arrive as
 * `{ error: { code, message } }` (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_UNIQUE`,
 * `RATE_LIMITED`, `INTERNAL_SERVER_ERROR`, ...) and become `EmailProviderError`s with that
 * code; a network failure is `NETWORK_ERROR` and a timeout `TIMEOUT`. The API key never
 * appears in an error.
 */
export function createUseSendSender(options: {
  apiKey: string
  baseUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
}): EmailSender {
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/api/v1/emails`
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_USESEND_TIMEOUT_MS
  return {
    provider: 'usesend',
    async send(message) {
      let response: Response
      try {
        response = await send(endpoint, {
          body: JSON.stringify({
            from: formatSender(message.from),
            headers: { ...message.headers },
            html: message.html,
            subject: message.subject,
            text: message.text,
            to: message.to
          }),
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.idempotencyKey
          },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw timedOut
          ? new EmailProviderError('TIMEOUT', `useSend did not answer within ${timeoutMs} ms.`)
          : new EmailProviderError('NETWORK_ERROR', 'useSend could not be reached.')
      }
      const body = await jsonBody(response)
      if (!response.ok) {
        const detail = scrubSecrets(useSendErrorMessage(body), options.apiKey)
        throw new EmailProviderError(
          useSendErrorCode(body, response.status),
          `useSend answered ${response.status}${detail ? `: ${detail}` : ''}`
        )
      }
      const emailId =
        typeof body === 'object' && body !== null && 'emailId' in body ? body.emailId : null
      return { messageId: typeof emailId === 'string' ? emailId : null }
    }
  }
}

/**
 * Writes the whole message (recipient, subject, and text body) to the log instead of sending
 * it. Only the local environment uses it: deployed logs must never hold message bodies.
 */
export interface DevOutboxEmail {
  sentAt: number
  subject: string
  text: string
  to: string
}

const DEV_OUTBOX_KEY = Symbol.for('best.serp.co/dev-email-outbox')
const DEV_OUTBOX_LIMIT = 100
const DEV_OUTBOX_LIFETIME_MS = 30 * 60 * 1000

function devOutbox(): DevOutboxEmail[] {
  const scope = globalThis as typeof globalThis & { [DEV_OUTBOX_KEY]?: DevOutboxEmail[] }
  scope[DEV_OUTBOX_KEY] ||= []
  return scope[DEV_OUTBOX_KEY]
}

/**
 * The messages the local log sender delivered to `to` in the last 30 minutes, newest first.
 * Local `wrangler dev` runs one isolate, so every request sees the same outbox (like the dev
 * sign-in code outbox in `lib/auth/otp-sender.ts`).
 */
export function readDevEmailOutbox(to: string, now = Date.now()): DevOutboxEmail[] {
  const recipient = to.trim().toLowerCase()
  return devOutbox()
    .filter(entry => entry.to === recipient && now - entry.sentAt <= DEV_OUTBOX_LIFETIME_MS)
    .reverse()
}

export function clearDevEmailOutbox(): void {
  devOutbox().length = 0
}

export function createLogEmailSender(
  write: (line: string) => void = line => console.info(line),
  options: { devOutbox?: boolean } = {}
): EmailSender {
  return {
    provider: 'log',
    async send(message) {
      if (options.devOutbox) {
        const outbox = devOutbox()
        outbox.push({
          sentAt: Date.now(),
          subject: message.subject,
          text: message.text,
          to: message.to.toLowerCase()
        })
        if (outbox.length > DEV_OUTBOX_LIMIT) outbox.splice(0, outbox.length - DEV_OUTBOX_LIMIT)
      }
      write(
        JSON.stringify({
          event: 'email_logged',
          from: formatSender(message.from),
          htmlLength: message.html.length,
          subject: message.subject,
          text: message.text,
          to: message.to
        })
      )
      return { messageId: null }
    }
  }
}

export interface CapturingEmailSender extends EmailSender {
  /** Messages the sender accepted, in order. */
  readonly sent: OutgoingEmail[]
  /** Makes the next send reject with this error (once). */
  failNext(error: unknown): void
}

export function createCapturingEmailSender(): CapturingEmailSender {
  const sent: OutgoingEmail[] = []
  const failures: unknown[] = []
  return {
    failNext(error) {
      failures.push(error)
    },
    provider: 'capture',
    async send(message) {
      if (failures.length > 0) throw failures.shift()
      sent.push(structuredClone(message))
      return { messageId: `capture-${sent.length}` }
    },
    sent
  }
}

/** The provider error code (`RATE_LIMITED`), or `E_UNKNOWN`. */
export function emailErrorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : 'E_UNKNOWN'
}

const ADDRESS_IN_TEXT = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/gu

/** An error message fit for logs: addresses and tokens redacted, at most 300 characters. */
export function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return scrubSecrets(message).replace(ADDRESS_IN_TEXT, '[redacted]').slice(0, 300)
}
