import 'server-only'

import { notFound, redirect } from 'next/navigation'
import type { SessionUser } from '../auth/guards'
import { toSummary } from '../submissions/http'
import { ownSubmissionForPage } from '../submissions/pages'
import type { OwnSubmission } from '../submissions/repository'
import { ordersEnabled } from './runtime'

/**
 * The paid checkout pages' shared setup (#68, #70 screen 4): the owner's submission (signed
 * out, `/login` and back), a 404 while orders are off, and the product the screens show.
 */

/** A submission a payment can still apply to (`payableSubmission` in the service). */
export function checkoutPayable(submission: OwnSubmission): boolean {
  return (
    submission.status === 'draft' ||
    submission.status === 'pending_badge' ||
    (submission.status === 'verified' && submission.plan === 'free')
  )
}

export async function checkoutPage(
  id: string,
  path: string
): Promise<{
  product: { logoUrl: string | null; name: string; slug: string }
  submission: OwnSubmission
  user: SessionUser
}> {
  const { submission, user } = await ownSubmissionForPage(id, path)
  if (!(await ordersEnabled())) notFound()
  const summary = toSummary(submission)
  return {
    product: { logoUrl: summary.logoUrl || null, name: submission.name, slug: submission.slug },
    submission,
    user
  }
}

/** Where a submission that can no longer be paid for stands. */
export function toAccount(submission: OwnSubmission): never {
  redirect(`/account/submissions/${submission.id}/`)
}
