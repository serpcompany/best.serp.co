import 'server-only'

/**
 * Sign-in codes as email in staging and production (serpcompany/best.serp.co#60, #61): the
 * bridge from `OtpSender` (`otp-sender.ts`) to the email module's `enqueueEmail`. The email is
 * delivered after the response through `waitUntil`, at most once per event key; every code is
 * a new event, so the key is a fresh UUID and never derives from the code.
 *
 * `templateRegistered` is true once the `sign-in-code` template is in the email registry (#61).
 * Without it, `selectOtpSender` keeps the 503 `OTP_DELIVERY_UNAVAILABLE` answer; with it, each
 * code request first checks `deliveryConfigured` and answers the same 503 when this Worker's
 * email is disabled. A code is never created without a way to deliver it.
 *
 * Each code adds an `email_deliveries` row that no retry needs once the provider's 24-hour
 * idempotency window has passed, so every send also prunes a small batch of older
 * `sign-in-code` rows (`pruneStale`) after the response (`waitUntil`, like the email itself),
 * until a scheduled job exists (#66). It never delays or fails a code request.
 */
import { appEmailTemplates } from '../email/registry'
import { emailDeliveryConfigured, emailEventKey, enqueueEmail } from '../email/server'
import { SIGN_IN_CODE_TEMPLATE_ID, type SignInCodeEmail } from './otp-sender'

/** How long a sign-in-code delivery row is kept: the provider's idempotency window. */
export const SIGN_IN_CODE_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000
/** Stale rows one send may prune; more than one code adds, so the ledger shrinks. */
export const SIGN_IN_CODE_PRUNE_BATCH = 20

export interface SignInCodeEmailOptions {
  /**
   * Deletes up to `limit` `sign-in-code` delivery rows created before `before`
   * (`pruneEmailDeliveries` on the account binding).
   */
  pruneStale(input: { before: Date; limit: number }): Promise<number>
  /** Keeps `task` running after the response: the request's `ctx.waitUntil`. */
  afterResponse(task: Promise<unknown>): Promise<void>
  clock?: () => Date
}

function logPruneFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'sign_in_code_prune_failed',
      message: error instanceof Error ? error.message : String(error)
    })
  )
}

export function createSignInCodeEmail({
  afterResponse,
  clock = () => new Date(),
  pruneStale
}: SignInCodeEmailOptions): SignInCodeEmail {
  return {
    // Checked before each code: a Worker that cannot deliver email answers 503 instead.
    deliveryConfigured: emailDeliveryConfigured,
    async enqueue({ eventKey, input, to }) {
      // Typed against the registered template: the build fails if its input changes shape.
      await enqueueEmail(SIGN_IN_CODE_TEMPLATE_ID, { eventKey, input, to })
      // Housekeeping off the request path (PR #76 review, finding 5): the response neither
      // waits for the pruning nor depends on it.
      let pruning: Promise<unknown>
      try {
        pruning = pruneStale({
          before: new Date(clock().getTime() - SIGN_IN_CODE_DELIVERY_RETENTION_MS),
          limit: SIGN_IN_CODE_PRUNE_BATCH
        }).catch(logPruneFailure)
      } catch (error) {
        logPruneFailure(error)
        return
      }
      await afterResponse(pruning).catch(logPruneFailure)
    },
    eventKey: () => emailEventKey('sign-in-code', crypto.randomUUID()),
    templateRegistered: Object.hasOwn(appEmailTemplates, SIGN_IN_CODE_TEMPLATE_ID)
  }
}
