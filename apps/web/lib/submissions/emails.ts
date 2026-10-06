import 'server-only'

import { EMAIL_ADMIN_RECIPIENT, emailEventKey, enqueueEmail } from '@/lib/email/server'
import { verificationInstant } from './contract'
import type { OwnSubmission } from './repository'

/**
 * The emails a verified free submission sends (serpcompany/best.serp.co#63): "submission
 * received" to the submitter and "ready for review" to the admin recipient. Both share the
 * event key `submission-verified:<id>`, so the email ledger sends each once per submission
 * even if verification is reported twice.
 */
export async function sendSubmissionVerifiedEmails(input: {
  submission: OwnSubmission
  submitterEmail: string
}): Promise<void> {
  const { submission, submitterEmail } = input
  const eventKey = emailEventKey('submission-verified', submission.id)
  const category = submission.categoryName ?? submission.categorySlug
  const verifiedAt = verificationInstant(submission.badgeVerifiedAt)
  await Promise.all([
    enqueueEmail('submission-received', {
      eventKey,
      input: { category, submissionName: submission.name, website: submission.website },
      to: submitterEmail
    }),
    enqueueEmail('admin-review-ready', {
      eventKey,
      input: {
        category,
        plan: {
          badgeVerifiedAt: verifiedAt === null ? new Date() : new Date(verifiedAt),
          kind: 'free'
        },
        source: 'submission',
        submissionId: submission.id,
        submissionName: submission.name,
        submittedBy: submitterEmail,
        website: submission.website
      },
      to: EMAIL_ADMIN_RECIPIENT
    })
  ])
}
