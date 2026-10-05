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
 */
import { appEmailTemplates } from '../email/registry'
import { emailDeliveryConfigured, emailEventKey, enqueueEmail } from '../email/server'
import { SIGN_IN_CODE_TEMPLATE_ID, type SignInCodeEmail } from './otp-sender'

export const signInCodeEmail: SignInCodeEmail = {
  // Checked before each code: a Worker that cannot deliver email answers 503 instead.
  deliveryConfigured: emailDeliveryConfigured,
  // Typed against the registered template: the build fails if its input changes shape.
  enqueue: ({ eventKey, input, to }) =>
    enqueueEmail(SIGN_IN_CODE_TEMPLATE_ID, { eventKey, input, to }),
  eventKey: () => emailEventKey('sign-in-code', crypto.randomUUID()),
  templateRegistered: Object.hasOwn(appEmailTemplates, SIGN_IN_CODE_TEMPLATE_ID)
}
