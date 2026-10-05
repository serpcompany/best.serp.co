import { adminNewMessageEmail, adminReviewReadyEmail } from './emails/admin'
import { claimCodeEmail, signInCodeEmail } from './emails/codes'
import { draftExpiredEmail, draftReminderEmail } from './emails/drafts'
import {
  badgeMissingEmail,
  listingApprovedEmail,
  listingLivePaidEmail,
  listingUnlistedEmail,
  ownershipRemovedEmail
} from './emails/listings'
import { newMessageEmail } from './emails/messages'
import {
  changesRequestedEmail,
  paymentReceivedInReviewEmail,
  submissionReceivedEmail,
  submissionRejectedEmail,
  submissionRejectedProhibitedEmail,
  submissionRejectedRefundedEmail
} from './emails/submissions'
import { SIGN_IN_CODE_TEMPLATE } from './sign-in-code'
import { createEmailTemplateRegistry } from './templates'

/**
 * Every email best.serp.co sends, keyed by template id, built to the mockups approved in
 * serpcompany/best.serp.co#70 (screen 15). Template ids are stable: they are part of each
 * delivery's ledger key and provider idempotency key, so renaming one would resend.
 *
 * Callers: `enqueueEmail('<id>', { eventKey, input, to })` from `./server.ts`. Admin alerts go
 * to `EMAIL_ADMIN_RECIPIENT`. Better Auth's OTP sender (`lib/auth/sign-in-code-email.ts`,
 * #60) enqueues the sign-in code (`SIGN_IN_CODE_TEMPLATE`) for sign-in codes only, keyed
 * `emailEventKey('sign-in-code', crypto.randomUUID())`; the code's length and lifetime are
 * defined once, in `./sign-in-code.ts`.
 */
export const appEmailTemplates = createEmailTemplateRegistry({
  'admin-new-message': adminNewMessageEmail,
  'admin-review-ready': adminReviewReadyEmail,
  'badge-missing': badgeMissingEmail,
  'changes-requested': changesRequestedEmail,
  'claim-code': claimCodeEmail,
  'draft-expired': draftExpiredEmail,
  'draft-reminder': draftReminderEmail,
  'listing-approved': listingApprovedEmail,
  'listing-live-paid': listingLivePaidEmail,
  'listing-unlisted': listingUnlistedEmail,
  'new-message': newMessageEmail,
  'ownership-removed': ownershipRemovedEmail,
  'payment-received-in-review': paymentReceivedInReviewEmail,
  [SIGN_IN_CODE_TEMPLATE]: signInCodeEmail,
  'submission-received': submissionReceivedEmail,
  'submission-rejected': submissionRejectedEmail,
  'submission-rejected-prohibited': submissionRejectedProhibitedEmail,
  'submission-rejected-refunded': submissionRejectedRefundedEmail
})

export type AppEmailTemplates = typeof appEmailTemplates
