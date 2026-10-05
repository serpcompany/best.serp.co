import { authorizeUserRequest } from '@/lib/auth/server'
import { fieldErrors, LOGO_MESSAGES, newDraftSchema } from '@/lib/submissions/contract'
import {
  apiError,
  authorizationFailure,
  json,
  readJson,
  submissionFailure,
  toAvailability,
  toSummary,
  unavailableResponse
} from '@/lib/submissions/http'
import { checkLogoUrl } from '@/lib/submissions/prefill'
import {
  checkSubmissionUrl,
  consumeSubmissionRateLimit,
  createDraft
} from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/submissions` (serpcompany/best.serp.co#63): saves the signed-in owner's draft
 * (`status = 'draft'`, no plan yet) and answers where to go next: the plan choice (2b).
 */
export async function POST(request: Request) {
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const parsed = newDraftSchema.safeParse((await readJson(request)) ?? {})
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
    const logo = await checkLogoUrl(parsed.data.logoUrl)
    if (!logo.ok) {
      return apiError(400, logo.code, LOGO_MESSAGES[logo.code], {
        fields: { logoUrl: LOGO_MESSAGES[logo.code] }
      })
    }
    const draft = await createDraft(owner, parsed.data)
    return json({ next: `/submit/${draft.id}/choose/?saved=1`, submission: toSummary(draft) }, 201)
  } catch (error) {
    return submissionFailure(error, 'Unable to save the draft.')
  }
}
