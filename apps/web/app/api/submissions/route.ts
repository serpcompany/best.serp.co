import { authorizeUserRequest } from '@/lib/auth/server'
import { hostSubmissionImages } from '@/lib/media/server'
import {
  fieldErrors,
  LOGO_MESSAGES,
  logoUrlProblem,
  newDraftSchema
} from '@/lib/submissions/contract'
import {
  apiError,
  authorizationFailure,
  json,
  payloadTooLarge,
  readJsonBody,
  submissionFailure,
  toAvailability,
  toSummary,
  unavailableResponse
} from '@/lib/submissions/http'
import { checkLogoUrl } from '@/lib/submissions/prefill'
import {
  checkSubmissionUrl,
  consumeSubmissionRateLimit,
  createDraft,
  insecureLogosAllowed
} from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/submissions` (serpcompany/best.serp.co#63): saves the signed-in owner's draft
 * (`status = 'draft'`, no plan yet) and answers where to go next: the plan choice (2b).
 */
export async function POST(request: Request) {
  const tooLarge = payloadTooLarge(request)
  if (tooLarge) return tooLarge
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const body = await readJsonBody(request)
  if (body.response) return body.response
  const parsed = newDraftSchema.safeParse(body.value ?? {})
  if (!parsed.success) {
    return apiError(400, 'invalid_submission', 'Check the highlighted fields.', {
      fields: fieldErrors(parsed.error)
    })
  }
  const owner = authorization.user.id
  try {
    await consumeSubmissionRateLimit(`user:${owner}`)
    // Answer duplicates and blocks before fetching the logo.
    const availability = toAvailability(await checkSubmissionUrl(parsed.data.website, owner))
    if (availability.kind !== 'available') return unavailableResponse(availability)
    const httpsProblem = logoUrlProblem(parsed.data.logoUrl, await insecureLogosAllowed())
    if (httpsProblem) {
      return apiError(400, 'invalid_logo', httpsProblem, { fields: { logoUrl: httpsProblem } })
    }
    const logo = await checkLogoUrl(parsed.data.logoUrl)
    if (!logo.ok) {
      return apiError(400, logo.code, LOGO_MESSAGES[logo.code], {
        fields: { logoUrl: LOGO_MESSAGES[logo.code] }
      })
    }
    const draft = await createDraft(owner, parsed.data)
    // Copied to the media host under the submission after the response (#95); never fails the
    // save. The featured image is the server's own prefill of the submitted website, never a
    // URL the client sends (#96 review round 2, B1).
    await hostSubmissionImages({
      logoUrl: draft.logoUrl,
      submissionId: draft.id,
      website: draft.website
    }).catch(() => undefined)
    return json({ next: `/submit/${draft.id}/choose/?saved=1`, submission: toSummary(draft) }, 201)
  } catch (error) {
    return submissionFailure(error, 'Unable to save the draft.')
  }
}
