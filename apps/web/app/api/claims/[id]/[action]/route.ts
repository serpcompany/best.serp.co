import { clientIp } from '@/lib/auth/rate-limits'
import { authorizeUserRequest, consumeRequestRateLimit } from '@/lib/auth/server'
import { claimFailure, claimsOff, json } from '@/lib/claims/http'
import { claimDependencies, currentClaimFlags } from '@/lib/claims/runtime'
import { checkClaimBadge, confirmClaimEmail } from '@/lib/claims/service'
import { verifyFeaturedBadge } from '@/lib/submissions/badge-verifier'
import {
  apiError,
  authorizationFailure,
  payloadTooLarge,
  readJsonBody
} from '@/lib/submissions/http'
import { badgeCheckRateLimitRules } from '@/lib/submissions/limits'
import { submissionBadgeVerificationTargets } from '@/lib/submissions/presentation'

export const dynamic = 'force-dynamic'

const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * The claimer's steps on their claim (#67), `POST /api/claims/<id>/<action>`:
 * - `confirm` `{ code }`: the domain-email code (single use; five wrong codes lock the claim
 *   for 15 minutes; an expired code needs a new one).
 * - `verify-badge`: the free method's badge check, as the submit flow checks a badge; a pass
 *   makes the claimer the owner (`badge_claim`).
 * Every read and write is scoped to the session's user in SQL, so someone else's claim is a
 * 404; a trusted `Origin` is required (CSRF).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string; id: string }> }
) {
  if (!(await currentClaimFlags()).enabled) return claimsOff()
  const tooLarge = payloadTooLarge(request, 1_000)
  if (tooLarge) return tooLarge
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const { action, id } = await context.params
  if (!CLAIM_ID.test(id)) return apiError(404, 'not_found', 'Claim not found.')
  const { user } = authorization
  try {
    const deps = await claimDependencies()
    if (action === 'confirm') {
      const body = await readJsonBody(request, 1_000)
      if (body.response) return body.response
      const value = (body.value ?? {}) as Record<string, unknown>
      const code = typeof value.code === 'string' ? value.code.slice(0, 20) : ''
      const result = await confirmClaimEmail(deps, { claimId: id, code, userId: user.id })
      return result.ok ? json({ claim: result.claim }) : claimFailure(result)
    }
    if (action === 'verify-badge') {
      const result = await checkClaimBadge(
        {
          ...deps,
          async budget(claimId) {
            const decision = await consumeRequestRateLimit(
              badgeCheckRateLimitRules({
                ip: clientIp(request.headers),
                submissionId: claimId,
                userId: user.id
              })
            )
            return decision.allowed ? null : { retryAfterSeconds: decision.retryAfterSeconds }
          },
          verifyBadge: listing =>
            verifyFeaturedBadge(listing.website, submissionBadgeVerificationTargets(listing.slug))
        },
        { actor: user.email, claimId: id, userId: user.id }
      )
      return result.ok ? json({ claim: result.claim, result: result.result }) : claimFailure(result)
    }
    return apiError(404, 'not_found', 'Not found.')
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'claim_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return apiError(500, 'claim_failed', 'Unable to update the claim.')
  }
}
