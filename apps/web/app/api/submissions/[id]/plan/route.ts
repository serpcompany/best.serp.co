import { authorizeUserRequest } from '@/lib/auth/server'
import { planRequestSchema } from '@/lib/submissions/contract'
import {
  apiError,
  authorizationFailure,
  json,
  readJson,
  submissionFailure,
  toSummary
} from '@/lib/submissions/http'
import { chooseFreePlan } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * `POST /api/submissions/<id>/plan` (#63): the owner picks how to get listed. Only `free` is
 * accepted until the paid listing ships (#68): the draft moves to `pending_badge` and the
 * badge step (3) comes next.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeUserRequest(request)
  if (!authorization.ok) return authorizationFailure(authorization)
  const { id } = await context.params
  if (!UUID.test(id)) return apiError(404, 'not_found', 'Submission not found.')
  const parsed = planRequestSchema.safeParse((await readJson(request)) ?? {})
  if (!parsed.success) return apiError(400, 'invalid_plan', 'Choose the free listing.')
  try {
    const submission = await chooseFreePlan(id, authorization.user.id)
    return json({ next: `/submit/${submission.id}/badge/`, submission: toSummary(submission) })
  } catch (error) {
    return submissionFailure(error, 'Unable to choose the plan.')
  }
}
