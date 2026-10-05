/**
 * Email providers behind one interface, so the provider can change without touching callers
 * or templates:
 *
 * - `createCloudflareEmailSender`: Cloudflare Email Service through the Workers `send_email`
 *   binding (`EMAIL`), staging and production.
 * - `createLogEmailSender`: writes each message to the Worker log; local development only.
 * - `createCapturingEmailSender`: records messages in memory for tests.
 *
 * Workers API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

export interface EmailSenderAddress {
  email: string
  name?: string
}

export interface OutgoingEmail {
  from: EmailSenderAddress
  headers: Readonly<Record<string, string>>
  html: string
  replyTo?: string
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
  /** Recorded with each delivery: `cloudflare`, `log`, or `capture`. */
  readonly provider: string
  /** Resolves once the provider accepted the message; rejects when it did not. */
  send(message: OutgoingEmail): Promise<EmailSendReceipt>
}

/**
 * The structured `send()` of a Workers `send_email` binding (the subset this module uses).
 * It resolves with the accepted message's id and throws an Error with a `code` such as
 * `E_SENDER_NOT_VERIFIED`, `E_RECIPIENT_SUPPRESSED`, or `E_RATE_LIMIT_EXCEEDED`.
 */
export interface SendEmailBinding {
  send(message: {
    from: EmailSenderAddress | string
    headers?: Record<string, string>
    html?: string
    replyTo?: EmailSenderAddress | string
    subject: string
    text?: string
    to: string | string[]
  }): Promise<{ messageId: string }>
}

export function createCloudflareEmailSender(binding: SendEmailBinding): EmailSender {
  return {
    provider: 'cloudflare',
    async send(message) {
      const result = await binding.send({
        from: { ...message.from },
        headers: { ...message.headers },
        html: message.html,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        to: message.to
      })
      return { messageId: typeof result?.messageId === 'string' ? result.messageId : null }
    }
  }
}

/**
 * Writes the whole message (recipient, subject, and text body) to the log instead of sending
 * it. Only the local environment uses it: deployed logs must never hold message bodies.
 */
export function createLogEmailSender(
  write: (line: string) => void = line => console.info(line)
): EmailSender {
  return {
    provider: 'log',
    async send(message) {
      write(
        JSON.stringify({
          event: 'email_logged',
          from: message.from,
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

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u

/** The provider error code (`E_RATE_LIMIT_EXCEEDED`), or `E_UNKNOWN`. */
export function emailErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : 'E_UNKNOWN'
}

const ADDRESS_IN_TEXT = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/gu

/** An error message fit for logs: addresses redacted, at most 300 characters. */
export function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(ADDRESS_IN_TEXT, '[redacted]').slice(0, 300)
}
