import {
  allowResubmission,
  approveSubmission,
  rejectSubmission,
  requestSubmissionChanges
} from '@/lib/admin/decisions'
import { runAdminDecision, unknownAdminEndpoint } from '@/lib/admin/requests'
import {
  allowResubmissionSchema,
  approveSubmissionSchema,
  decisionIdSchema,
  rejectSubmissionSchema,
  requestChangesSchema
} from '@/lib/admin/schemas'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * Review decisions on one submission (#64 screen 11): `approve` (optionally with the reviewer's
 * edits and outbound link), `request-changes`, `reject`, and `allow-resubmission` (lifts the
 * prohibited-URL block a rejection created).
 */
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ action: string; id: string }>
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  const { action, id } = await params
  const submissionId = decisionIdSchema.safeParse(id)
  if (!submissionId.success) return unknownAdminEndpoint()
  const actor = authorization.user.email
  switch (action) {
    case 'approve':
      return runAdminDecision(request, actor, approveSubmissionSchema, (context, body) =>
        approveSubmission(context, { ...body, submissionId: submissionId.data })
      )
    case 'request-changes':
      return runAdminDecision(request, actor, requestChangesSchema, (context, body) =>
        requestSubmissionChanges(context, { ...body, submissionId: submissionId.data })
      )
    case 'reject':
      return runAdminDecision(request, actor, rejectSubmissionSchema, (context, body) =>
        rejectSubmission(context, { ...body, submissionId: submissionId.data })
      )
    case 'allow-resubmission':
      return runAdminDecision(request, actor, allowResubmissionSchema, (context, body) =>
        allowResubmission(context, body)
      )
    default:
      return unknownAdminEndpoint()
  }
}
