import { extrasRequestSchema, resubmitRequestSchema } from '@/lib/account/contract'
import { sendResubmittedAlert } from '@/lib/account/emails'
import { ACCOUNT_ID, accountNotFound, changedLogoProblem, parseBody } from '@/lib/account/requests'
import { accountOperations } from '@/lib/account/runtime'
import { authorizeUserRequest } from '@/lib/auth/server'
import {
  authorizationFailure,
  json,
  payloadTooLarge,
  readJsonBody,
  submissionFailure
} from '@/lib/submissions/http'
import { consumeSubmissionRateLimit } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

/**
 * The submitter's actions on their own submission (#65, #70 screen 6), `POST
 * /api/account/submissions/<id>/<action>`:
 *
 * - `withdraw`: before any payment, while nothing is live (#59 owner decision).
 * - `resubmit`: the fixed details of a changes-requested submission, then back to the review
 *   queue it left, in one batch. The admin recipient gets "ready for review".
 * - `extras`: FAQs and links while it waits for review.
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
  if (!ACCOUNT_ID.test(id)) return accountNotFound('submission')
  const body = await readJsonBody(request)
  if (body.response) return body.response
  const { user } = authorization
  try {
    const operations = await accountOperations()
    if (action === 'withdraw') {
      await operations.withdrawSubmission({ submissionId: id, userId: user.id })
      return json({ ok: true })
    }
    if (action === 'resubmit') {
      const parsed = parseBody(resubmitRequestSchema, body.value)
      if (!parsed.ok) return parsed.response
      const current = await operations.submission(user.id, id)
      if (!current) return accountNotFound('submission')
      await consumeSubmissionRateLimit(`user:${user.id}`)
      const { expectedContentVersion, ...content } = parsed.data
      if (content.logoUrl !== current.logoUrl) {
        const problem = await changedLogoProblem(content.logoUrl)
        if (problem) return problem
      }
      const submission = await operations.resubmitSubmission({
        content,
        expectedContentVersion,
        submissionId: id,
        userId: user.id
      })
      await sendResubmittedAlert({ submission, submitterEmail: user.email })
      return json({ ok: true, status: submission.status })
    }
    if (action === 'extras') {
      const parsed = parseBody(extrasRequestSchema, body.value)
      if (!parsed.ok) return parsed.response
      await consumeSubmissionRateLimit(`user:${user.id}`)
      const { expectedContentVersion, ...extras } = parsed.data
      const submission = await operations.saveSubmissionExtras({
        expectedContentVersion,
        extras,
        submissionId: id,
        userId: user.id
      })
      return json({ contentVersion: submission.contentVersion, ok: true })
    }
    return accountNotFound('submission')
  } catch (error) {
    return submissionFailure(error, 'Unable to save the changes.')
  }
}
