import { validateExtras } from '@/db/account'
import { validateDraftContent } from '@/db/submissions'
import { extrasRequestSchema, resubmitRequestSchema } from '@/lib/account/contract'
import { sendResubmittedAlert } from '@/lib/account/emails'
import {
  ACCOUNT_ID,
  accountNotFound,
  changedLogoProblem,
  parseBody,
  spendAccountEdit,
  staleAnswer
} from '@/lib/account/requests'
import { accountOperations } from '@/lib/account/runtime'
import { authorizeUserRequest } from '@/lib/auth/server'
import { hostSubmissionImages } from '@/lib/media/server'
import {
  apiError,
  authorizationFailure,
  json,
  payloadTooLarge,
  readJsonBody,
  submissionFailure
} from '@/lib/submissions/http'
import { insecureLogosAllowed } from '@/lib/submissions/repository'

export const dynamic = 'force-dynamic'

/**
 * The submitter's actions on their own submission (#65, #70 screen 6), `POST
 * /api/account/submissions/<id>/<action>`:
 *
 * - `withdraw`: before any payment, while nothing is live (#59 owner decision).
 * - `resubmit`: the fixed details (and, optionally, FAQs and links) of a changes-requested
 *   submission, then back to the review queue it left, in one batch. The admin recipient gets
 *   "ready for review".
 * - `extras`: FAQs and links while it waits for review.
 *
 * Every read and write is scoped to the session's user in SQL, so someone else's id is a 404.
 * An edit spends the account's edit budget only once it is valid (`lib/account/limits.ts`).
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
      if (current.status !== 'changes_requested') {
        return apiError(
          409,
          'not_editable',
          'Only a submission with requested changes can be resubmitted.'
        )
      }
      const { expectedContentVersion, faqs, resourceLinks, ...content } = parsed.data
      if (expectedContentVersion !== current.contentVersion) return staleAnswer('submission')
      validateDraftContent(content, await insecureLogosAllowed())
      const extras = faqs && resourceLinks ? validateExtras({ faqs, resourceLinks }) : undefined
      const limited = await spendAccountEdit(user.id)
      if (limited) return limited
      if (content.logoUrl !== current.logoUrl) {
        const problem = await changedLogoProblem(content.logoUrl)
        if (problem) return problem
      }
      const submission = await operations.resubmitSubmission({
        content,
        expectedContentVersion,
        extras,
        submissionId: id,
        userId: user.id
      })
      // A changed logo replaces the submission's hosted copy after the response (#95).
      if (submission.logoUrl !== current.logoUrl) {
        await hostSubmissionImages({ logoUrl: submission.logoUrl, submissionId: id }).catch(
          () => undefined
        )
      }
      await sendResubmittedAlert({ submission, submitterEmail: user.email })
      return json({ ok: true, status: submission.status })
    }
    if (action === 'extras') {
      const parsed = parseBody(extrasRequestSchema, body.value)
      if (!parsed.ok) return parsed.response
      const current = await operations.submission(user.id, id)
      if (!current) return accountNotFound('submission')
      if (current.status !== 'verified' && current.status !== 'paid_pending_review') {
        return apiError(
          409,
          'not_editable',
          'FAQs and links can be added here while the submission waits for review.'
        )
      }
      const { expectedContentVersion, ...extras } = parsed.data
      if (expectedContentVersion !== current.contentVersion) return staleAnswer('submission')
      validateExtras(extras)
      const limited = await spendAccountEdit(user.id)
      if (limited) return limited
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
