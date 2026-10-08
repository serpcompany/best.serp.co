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
  payloadTooLarge,
  readJsonBody,
  submissionFailure,
  toAvailability
} from '@/lib/submissions/http'
import { prefillRateLimitRules } from '@/lib/submissions/limits'
import { readSitePrefill } from '@/lib/submissions/prefill'
import { checkSubmissionUrl, insecureLogosAllowed } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

const MAX_PREFILL_BODY_BYTES = 4_000

/**
 * `POST /api/submissions/prefill` (#63): checks whether a website can be submitted and, when it
 * can, reads its page to propose the name, short description, site icon, and social image.
 * The form works signed out, so this does too. Each call makes the Worker fetch the submitted
 * site, so it is rate-limited per client address for everyone and per account on top for a
 * signed-in caller, and its body is capped at 4 KB before it is read.
 */
export async function POST(request: Request) {
  const tooLarge = payloadTooLarge(request, MAX_PREFILL_BODY_BYTES)
  if (tooLarge) return tooLarge
  const origin = await checkRequestOrigin(request)
  if (origin) return authorizationFailure(origin)
  const body = await readJsonBody(request, MAX_PREFILL_BODY_BYTES)
  if (body.response) return body.response
  const parsed = prefillRequestSchema.safeParse(body.value ?? {})
  if (!parsed.success) return apiError(400, 'invalid_url', 'Enter a website address.')
  const website = normalizeWebsiteInput(parsed.data.url)
  try {
    const user = await getRequestUser(request)
    const limit = await consumeRequestRateLimit(
      prefillRateLimitRules({ ip: clientIp(request.headers), userId: user?.id ?? null })
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
    const prefill =
      availability.kind === 'available'
        ? await readSitePrefill(website, fetch, {
            allowInsecureLogos: await insecureLogosAllowed()
          })
        : null
    const response: PrefillResponse = { availability, prefill, website }
    return json(response)
  } catch (error) {
    return submissionFailure(error, 'Unable to read the page.')
  }
}
