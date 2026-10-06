import { validateExtras } from '@serpdirectory/data-ops/account'
import { revisionRequestSchema } from '@/lib/account/contract'
import { sendRevisionReadyAlert } from '@/lib/account/emails'
import {
  ACCOUNT_ID,
  accountNotFound,
  changedLogoProblem,
  parseBody,
  spendAccountEdit,
  staleAnswer
} from '@/lib/account/requests'
import { accountOperations } from '@/lib/account/runtime'
import { clientIp } from '@/lib/auth/rate-limits'
import { authorizeUserRequest, consumeRequestRateLimit } from '@/lib/auth/server'
import { hostRevisionLogo } from '@/lib/media/server'
import { verifyFeaturedBadge } from '@/lib/submissions/badge-verifier'
import {
  apiError,
  authorizationFailure,
  json,
  payloadTooLarge,
  readJsonBody,
  submissionFailure
} from '@/lib/submissions/http'
import { badgeCheckRateLimitRules } from '@/lib/submissions/limits'
import { submissionBadgeVerificationTargets } from '@/lib/submissions/presentation'

export const dynamic = 'force-dynamic'

/**
 * The owner's actions on a listing they own (#65, #70 screens 5 and 7), `POST
 * /api/account/listings/<id>/<action>`:
 *
 * - `revision`: stages edits of the live listing for review: a new revision, or the open one
 *   changed (and sent back to review when changes were requested). Nothing public changes until
 *   an admin approves it. A changed logo is checked as the submit flow checks one, then hosted
 *   under the revision's own media prefix after the response (#95, #96).
 * - `discard-revision`: withdraws the open revision.
 * - `verify-badge`: checks a live free listing's badge with the badge step's verifier (#84): one
 *   claim in a compare-and-swap (30-second cooldown, ten checks that find a result per 24
 *   hours), the outbound budget per submission, account, and client address, then the fetch.
 *
 * Every read and write is scoped to the session's user in SQL, so someone else's id is a 404.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string; id: string }> }
) {
  const tooLarge = payloadTooLarge(request)
  if (tooLarge) return tooLarge
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const { action, id } = await context.params
  if (!ACCOUNT_ID.test(id)) return accountNotFound('listing')
  const body = await readJsonBody(request)
  if (body.response) return body.response
  const { user } = authorization
  try {
    const operations = await accountOperations()
    if (action === 'revision') {
      const parsed = parseBody(revisionRequestSchema, body.value)
      if (!parsed.ok) return parsed.response
      const current = await operations.listingById(user.id, id)
      if (!current) return accountNotFound('listing')
      if (!current.live) {
        return apiError(409, 'not_editable', 'Only a live listing can be edited.')
      }
      const open =
        current.revision?.status === 'pending_review' ||
        current.revision?.status === 'changes_requested'
          ? current.revision
          : null
      // The form saves what it loaded: a stale tab never overwrites newer edits.
      if ((open?.contentVersion ?? null) !== parsed.data.expectedRevisionVersion) {
        return staleAnswer('listing')
      }
      validateExtras(parsed.data)
      const limited = await spendAccountEdit(user.id)
      if (limited) return limited
      const unchanged = [current.logoUrl, current.revision?.logoUrl].includes(parsed.data.logoUrl)
      if (!unchanged) {
        const problem = await changedLogoProblem(parsed.data.logoUrl)
        if (problem) return problem
      }
      const { expectedRevisionVersion, ...content } = parsed.data
      const saved = await operations.saveRevision({
        content,
        expectedRevisionVersion,
        listingId: id,
        newRevisionId: crypto.randomUUID(),
        userId: user.id
      })
      // A logo other than the listing's is hosted under the revision's own prefix after the
      // response, so the reviewer sees that copy and approval adopts exactly it (#96 round 4).
      if (parsed.data.logoUrl.trim() !== current.logoUrl) {
        await hostRevisionLogo({
          logoUrl: parsed.data.logoUrl.trim(),
          revisionId: saved.revisionId
        }).catch(() => undefined)
      }
      if (saved.queued) {
        const listing = await operations.listingById(user.id, id)
        if (listing) {
          await sendRevisionReadyAlert({
            listing,
            revisionId: saved.revisionId,
            submitterEmail: user.email
          })
        }
      }
      return json({ ok: true, revisionId: saved.revisionId })
    }
    if (action === 'discard-revision') {
      await operations.discardRevision({ listingId: id, userId: user.id })
      return json({ ok: true })
    }
    if (action === 'verify-badge') {
      const { claimedAt, listing } = await operations.claimListingBadgeCheck({
        listingId: id,
        userId: user.id
      })
      const submissionId = listing.badge?.submissionId ?? ''
      const budget = await consumeRequestRateLimit(
        badgeCheckRateLimitRules({ ip: clientIp(request.headers), submissionId, userId: user.id })
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
        listing.website,
        submissionBadgeVerificationTargets(listing.slug)
      )
      await operations.finishListingBadgeCheck({
        claimedAt,
        result: result.ok ? { ok: true } : { code: result.code, ok: false },
        submissionId,
        userId: user.id
      })
      return json({ ok: true, result })
    }
    return accountNotFound('listing')
  } catch (error) {
    return submissionFailure(error, 'Unable to save the changes.')
  }
}
