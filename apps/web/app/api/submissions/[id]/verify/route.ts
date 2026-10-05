import { authorizeUserRequest } from '@/lib/auth/server'
import { verifyFeaturedBadge } from '@/lib/submissions/badge-verifier'
import { sendSubmissionVerifiedEmails } from '@/lib/submissions/emails'
import {
  apiError,
  authorizationFailure,
  json,
  submissionFailure,
  toSummary
} from '@/lib/submissions/http'
import { submissionBadgeVerificationTargets } from '@/lib/submissions/presentation'
import { beginVerification, finishVerification } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * `POST /api/submissions/<id>/verify` (#63): the owner asks us to check the badge. At most ten
 * conclusive checks, one every 30 seconds; connection problems never use one up. A pass moves
 * the submission to `verified` (the review queue) and sends "submission received" to the
 * submitter and "ready for review" to the admin recipient.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const { id } = await context.params
  if (!UUID.test(id)) return apiError(404, 'not_found', 'Submission not found.')
  const { user } = authorization
  try {
    const current = await beginVerification(id, user.id)
    if (current.status !== 'pending_badge') {
      return apiError(409, 'not_pending_badge', 'This submission isn’t waiting for its badge.', {})
    }
    const result = await verifyFeaturedBadge(
      current.website,
      submissionBadgeVerificationTargets(current.slug)
    )
    const updated = await finishVerification(
      id,
      user.id,
      result.ok ? { ok: true } : { code: result.code, ok: false }
    )
    if (result.ok && updated.status === 'verified') {
      await sendSubmissionVerifiedEmails({ submission: updated, submitterEmail: user.email })
    }
    return json({
      result: result.ok
        ? { ok: true }
        : { code: result.code, ok: false, ...('href' in result ? { href: result.href } : {}) },
      submission: toSummary(updated)
    })
  } catch (error) {
    return submissionFailure(error, 'Unable to check the badge.')
  }
}
