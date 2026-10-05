import { authorizeUserRequest } from '@/lib/auth/server'
import {
  draftUpdateSchema,
  fieldErrors,
  LOGO_MESSAGES,
  nextStepPath
} from '@/lib/submissions/contract'
import {
  apiError,
  authorizationFailure,
  json,
  payloadTooLarge,
  readJson,
  submissionFailure,
  toSummary
} from '@/lib/submissions/http'
import { checkLogoUrl } from '@/lib/submissions/prefill'
import {
  consumeSubmissionRateLimit,
  getOwnSubmission,
  updateDraft
} from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function notFound() {
  return apiError(404, 'not_found', 'Submission not found.')
}

/**
 * `PATCH /api/submissions/<id>` (#63): the owner edits a saved draft's details (2b "Edit
 * details") while it is a draft or waiting for its badge. The website never changes.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const tooLarge = payloadTooLarge(request)
  if (tooLarge) return tooLarge
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const { id } = await context.params
  if (!UUID.test(id)) return notFound()
  const parsed = draftUpdateSchema.safeParse((await readJson(request)) ?? {})
  if (!parsed.success) {
    return apiError(400, 'invalid_submission', 'Check the highlighted fields.', {
      fields: fieldErrors(parsed.error)
    })
  }
  const owner = authorization.user.id
  try {
    const current = await getOwnSubmission(id, owner)
    if (!current) return notFound()
    await consumeSubmissionRateLimit(`user:${owner}`)
    const { expectedContentVersion, ...content } = parsed.data
    if (content.logoUrl !== current.logoUrl) {
      const logo = await checkLogoUrl(content.logoUrl)
      if (!logo.ok) {
        return apiError(400, logo.code, LOGO_MESSAGES[logo.code], {
          fields: { logoUrl: LOGO_MESSAGES[logo.code] }
        })
      }
    }
    const updated = await updateDraft({
      content,
      expectedContentVersion,
      ownerUserId: owner,
      submissionId: id
    })
    const next = nextStepPath(updated)
    return json({
      next: updated.status === 'draft' ? `${next}?saved=1` : next,
      submission: toSummary(updated)
    })
  } catch (error) {
    return submissionFailure(error, 'Unable to save the changes.')
  }
}
