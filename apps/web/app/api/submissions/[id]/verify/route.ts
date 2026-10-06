import { clientIp } from '@/lib/auth/rate-limits'
import { authorizeUserRequest, consumeRequestRateLimit } from '@/lib/auth/server'
import { verifyFeaturedBadge } from '@/lib/submissions/badge-verifier'
import { sendSubmissionVerifiedEmails } from '@/lib/submissions/emails'
import {
  apiError,
  authorizationFailure,
  json,
  submissionFailure,
  toSummary
} from '@/lib/submissions/http'
import { badgeCheckRateLimitRules } from '@/lib/submissions/limits'
import { submissionBadgeVerificationTargets } from '@/lib/submissions/presentation'
import { claimVerification, finishVerification } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * `POST /api/submissions/<id>/verify` (#63): the owner asks us to check the badge.
 *
 * 1. Claim the check in one compare-and-swap before anything is fetched (cooldown of 30
 *    seconds, ten conclusive checks): a request that loses the race gets 429 or 409.
 * 2. Count the fetch against the outbound budget per submission, per account and per client
 *    address, whatever its result, since connection problems never use up one of the ten
 *    checks.
 * 3. Fetch and scan the site, then record the result against the claim.
 *
 * A pass moves the submission to `verified` (the review queue) and sends "submission received"
 * to the submitter and "ready for review" to the admin recipient.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const { id } = await context.params
  if (!UUID.test(id)) return apiError(404, 'not_found', 'Submission not found.')
  const { user } = authorization
  try {
    const { claimedAt, submission } = await claimVerification(id, user.id)
    const budget = await consumeRequestRateLimit(
      badgeCheckRateLimitRules({ ip: clientIp(request.headers), submissionId: id, userId: user.id })
    )
    if (!budget.allowed) {
      return json(
        {
          code: 'check_budget',
          error: 'Too many checks for now. Try again later.',
          retryAfterSeconds: budget.retryAfterSeconds
        },
        429,
        { 'Retry-After': String(budget.retryAfterSeconds) }
      )
    }
    const result = await verifyFeaturedBadge(
      submission.website,
      submissionBadgeVerificationTargets(submission.slug)
    )
    const updated = await finishVerification(
      id,
      user.id,
      claimedAt,
      result.ok ? { ok: true } : { code: result.code, ok: false }
    )
    if (result.ok && updated.status === 'verified') {
      await sendSubmissionVerifiedEmails({ submission: updated, submitterEmail: user.email })
    }
    return json({ result, submission: toSummary(updated) })
  } catch (error) {
    return submissionFailure(error, 'Unable to check the badge.')
  }
}
