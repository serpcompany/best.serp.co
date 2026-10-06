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
import {
  claimVerification,
  finishVerification,
  getOwnSubmission,
  isSubmissionError
} from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Refusals that mean the page's copy of the submission is stale (another tab or request
 * checked it, or a claim started a cooldown it didn't see), so the answer carries the current
 * submission (PR #84 review round 2, finding 4).
 */
const STALE_PAGE_CODES = new Set([
  'attempt_limit',
  'cooldown',
  'not_pending_badge',
  'verification_superseded'
])

async function refusalWithSubmission(error: unknown, id: string, userId: string) {
  if (!isSubmissionError(error) || !STALE_PAGE_CODES.has(error.code)) return null
  try {
    const current = await getOwnSubmission(id, userId)
    return apiError(
      error.status,
      error.code,
      error.message,
      current ? { submission: toSummary(current) } : {}
    )
  } catch {
    return null
  }
}

/**
 * `POST /api/submissions/<id>/verify` (#63): the owner asks us to check the badge.
 *
 * 1. Claim the check in one compare-and-swap before anything is fetched (cooldown of 30
 *    seconds, ten conclusive checks): a request that loses the race gets 429 or 409, with the
 *    current submission so the page can catch up.
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
          retryAfterSeconds: budget.retryAfterSeconds,
          // The claim above started the 30-second cooldown.
          submission: toSummary(submission)
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
    return (
      (await refusalWithSubmission(error, id, user.id)) ??
      submissionFailure(error, 'Unable to check the badge.')
    )
  }
}
