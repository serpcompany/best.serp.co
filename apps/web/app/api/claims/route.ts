import { clientIp } from '@/lib/auth/rate-limits'
import { authorizeUserRequest, consumeRequestRateLimit } from '@/lib/auth/server'
import { claimFailure, claimsOff, json } from '@/lib/claims/http'
import { claimCodeRateLimitRules } from '@/lib/claims/limits'
import { claimDependencies, currentClaimFlags } from '@/lib/claims/runtime'
import { startClaim } from '@/lib/claims/service'
import {
  apiError,
  authorizationFailure,
  payloadTooLarge,
  readJsonBody
} from '@/lib/submissions/http'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/claims` (#67): starts (or restarts) the signed-in user's claim of a listing and
 * emails a code to the domain address. Body: `{ listing: <slug>, method: 'badge' | 'paid',
 * email }`. A trusted `Origin` is required (CSRF), the session decides the claimer, and the
 * sends count against the account and the client address.
 */
export async function POST(request: Request) {
  if (!(await currentClaimFlags()).enabled) return claimsOff()
  const tooLarge = payloadTooLarge(request, 4_000)
  if (tooLarge) return tooLarge
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const body = await readJsonBody(request, 4_000)
  if (body.response) return body.response
  const value = (body.value ?? {}) as Record<string, unknown>
  const listing = typeof value.listing === 'string' ? value.listing : ''
  const email = typeof value.email === 'string' ? value.email : ''
  const method = typeof value.method === 'string' ? value.method : ''
  if (!listing || listing.length > 300) return apiError(404, 'not_found', 'Listing not found.')
  try {
    const budget = await consumeRequestRateLimit(
      claimCodeRateLimitRules({ ip: clientIp(request.headers), userId: authorization.user.id })
    )
    if (!budget.allowed) {
      return claimFailure({
        code: 'cooldown',
        ok: false,
        retryAfterSeconds: budget.retryAfterSeconds,
        status: 429
      })
    }
    const result = await startClaim(await claimDependencies(), {
      email,
      listingSlug: listing,
      method,
      userId: authorization.user.id
    })
    if (!result.ok) return claimFailure(result)
    return json({ claim: result.claim }, 201)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'claim_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return apiError(500, 'claim_failed', 'Unable to start the claim.')
  }
}
