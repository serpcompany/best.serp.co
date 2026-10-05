import 'server-only'

/**
 * Sign-in codes as email in staging and production (serpcompany/best.serp.co#60, #61): the
 * bridge from `OtpSender` (`otp-sender.ts`) to the email module's `enqueueEmail`. The email is
 * delivered after the response through `waitUntil`, at most once per event key; every code is
 * a new event, so the key is a fresh UUID and never derives from the code.
 *
 * The `sign-in-code` template arrives with the #61 templates. Until it is in the registry,
 * `templateRegistered` is false and `selectOtpSender` keeps the 503 `OTP_DELIVERY_UNAVAILABLE`
 * answer, so a code is never created without a way to deliver it.
 */
import { type AppEmailTemplates, appEmailTemplates } from '../email/registry'
import { emailEventKey, enqueueEmail } from '../email/server'
import type { EmailRequest } from '../email/service'
import type { TemplateInput } from '../email/templates'
import {
  SIGN_IN_CODE_TEMPLATE_ID,
  type SignInCodeEmail,
  type SignInCodeEmailInput
} from './otp-sender'

/**
 * The registered template's input, once there is one. Assigning `SignInCodeEmailInput` to it
 * below stops the build if the template expects anything else.
 */
type RegisteredSignInCodeInput = AppEmailTemplates extends {
  readonly [SIGN_IN_CODE_TEMPLATE_ID]: infer Template
}
  ? TemplateInput<Template>
  : SignInCodeEmailInput

/**
 * `enqueueEmail` accepts only registered ids, and the registry is empty until #61's templates
 * land; this untyped view goes away with them.
 */
const enqueueAnyEmail = enqueueEmail as unknown as (
  templateId: string,
  request: EmailRequest<unknown>
) => Promise<void>

export const signInCodeEmail: SignInCodeEmail = {
  enqueue({ eventKey, input, to }) {
    const checked: RegisteredSignInCodeInput = input
    return enqueueAnyEmail(SIGN_IN_CODE_TEMPLATE_ID, { eventKey, input: checked, to })
  },
  eventKey: () => emailEventKey('sign-in-code', crypto.randomUUID()),
  templateRegistered: Object.hasOwn(appEmailTemplates, SIGN_IN_CODE_TEMPLATE_ID)
}
