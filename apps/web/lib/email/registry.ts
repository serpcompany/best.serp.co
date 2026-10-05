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
import { createEmailTemplateRegistry } from './templates'

/**
 * Every email best.serp.co sends, keyed by template id, built to the mockups approved in
 * serpcompany/best.serp.co#70 (screen 15). Template ids are stable: they are part of each
 * delivery's ledger key and provider idempotency key, so renaming one would resend.
 *
 * Callers: `enqueueEmail('<id>', { eventKey, input, to })` from `./server.ts`. Admin alerts go
 * to `EMAIL_ADMIN_RECIPIENT`. The sign-in code (`sign-in-code`) is enqueued by Better Auth's
 * `sendVerificationOTP` (#60/#72) with `emailEventKey('sign-in-code', crypto.randomUUID())`,
 * for OTP type `sign-in` only; its length and lifetime are `SIGN_IN_CODE_LENGTH` and
 * `SIGN_IN_CODE_TTL_SECONDS`.
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
  'sign-in-code': signInCodeEmail,
  'submission-received': submissionReceivedEmail,
  'submission-rejected': submissionRejectedEmail,
  'submission-rejected-prohibited': submissionRejectedProhibitedEmail,
  'submission-rejected-refunded': submissionRejectedRefundedEmail
})

export type AppEmailTemplates = typeof appEmailTemplates

/** The stable id Better Auth's OTP sender enqueues (#72). */
export const SIGN_IN_CODE_TEMPLATE = 'sign-in-code' satisfies keyof AppEmailTemplates
