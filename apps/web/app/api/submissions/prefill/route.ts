import { clientIp } from '@/lib/auth/rate-limits'
import { checkRequestOrigin, consumeRequestRateLimit, getRequestUser } from '@/lib/auth/server'
import {
  normalizeWebsiteInput,
  type PrefillResponse,
  prefillRequestSchema
} from '@/lib/submissions/contract'
import {
  apiError,
  authorizationFailure,
  json,
  readJson,
  submissionFailure,
  toAvailability
} from '@/lib/submissions/http'
import { prefillRateLimitRules } from '@/lib/submissions/limits'
import { readSitePrefill } from '@/lib/submissions/prefill'
import { checkSubmissionUrl } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/submissions/prefill` (#63): checks whether a website can be submitted and, when it
 * can, reads its page to propose the name, short description, site icon, and social image.
 * The form works signed out, so this does too; it is rate-limited per signed-in user, or per
 * client address for visitors, because each call makes the Worker fetch the submitted site.
 */
export async function POST(request: Request) {
  const origin = await checkRequestOrigin(request)
  if (origin) return authorizationFailure(origin)
  const parsed = prefillRequestSchema.safeParse((await readJson(request, 4_000)) ?? {})
  if (!parsed.success) return apiError(400, 'invalid_url', 'Enter a website address.')
  const website = normalizeWebsiteInput(parsed.data.url)
  try {
    const user = await getRequestUser(request)
    const limit = await consumeRequestRateLimit(
      prefillRateLimitRules(user ? { userId: user.id } : { ip: clientIp(request.headers) })
    )
    if (!limit.allowed) {
      return json(
        {
          code: 'rate_limited',
          error: 'Too many pages read. Try again in a few minutes, or fill in the fields yourself.'
        },
        429,
        { 'Retry-After': String(limit.retryAfterSeconds) }
      )
    }
    const availability = toAvailability(await checkSubmissionUrl(website, user?.id ?? null))
    const body: PrefillResponse = {
      availability,
      prefill: availability.kind === 'available' ? await readSitePrefill(website) : null,
      website
    }
    return json(body)
  } catch (error) {
    return submissionFailure(error, 'Unable to read the page.')
  }
}
