import 'server-only'

import type { AccountListingDetail, AccountSubmissionDetail } from '@serpdirectory/data-ops/account'
import { EMAIL_ADMIN_RECIPIENT, emailEventKey, enqueueEmail } from '@/lib/email/server'

/**
 * The review alerts the dashboard sends (#65): a resubmitted submission and an owner's edits of
 * a live listing go back to the review queue, so the admin recipient gets "ready for review",
 * as a newly verified submission does (#63). Each is keyed by the item and its content version,
 * so a retried request sends it once and a later resubmission sends again.
 */

export async function sendResubmittedAlert(input: {
  submission: AccountSubmissionDetail
  submitterEmail: string
}): Promise<void> {
  const { submission } = input
  await enqueueEmail('admin-review-ready', {
    eventKey: emailEventKey(
      'submission-resubmitted',
      submission.id,
      String(submission.contentVersion)
    ),
    input: {
      category: submission.categoryName ?? submission.categorySlug,
      plan:
        submission.plan === 'paid'
          ? { kind: 'paid', live: submission.listing?.live === true }
          : { badgeVerifiedAt: submission.badgeVerifiedAt ?? new Date(), kind: 'free' },
      source: 'submission',
      submissionId: submission.id,
      submissionName: submission.name,
      submittedBy: input.submitterEmail,
      website: submission.website
    },
    to: EMAIL_ADMIN_RECIPIENT
  })
}

/**
 * Sent when a revision enters the queue (new, or fixed after a change request). A listing with
 * no plan (an owner an admin assigned) has no plan line to show, so it sends nothing; the queue
 * still lists the revision.
 */
export async function sendRevisionReadyAlert(input: {
  listing: AccountListingDetail
  revisionId: string
  submitterEmail: string
}): Promise<void> {
  const { listing } = input
  const revision = listing.revision
  if (!listing.plan || !revision || revision.id !== input.revisionId) return
  const verified = listing.badge?.history.find(check => check.outcome === 'pass')?.at
  await enqueueEmail('admin-review-ready', {
    eventKey: emailEventKey('revision-ready', revision.id, String(revision.contentVersion)),
    input: {
      category: revision.categoryName ?? revision.categorySlug,
      plan:
        listing.plan === 'paid'
          ? { kind: 'paid', live: listing.live }
          : { badgeVerifiedAt: verified ?? listing.publishedAt ?? new Date(), kind: 'free' },
      source: 'revision',
      submissionId: revision.id,
      submissionName: listing.name,
      submittedBy: input.submitterEmail,
      website: listing.website
    },
    to: EMAIL_ADMIN_RECIPIENT
  })
}
