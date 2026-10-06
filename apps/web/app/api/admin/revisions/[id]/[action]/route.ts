import { approveRevision, rejectRevision, requestRevisionChanges } from '@/lib/admin/decisions'
import { runAdminDecision, unknownAdminEndpoint } from '@/lib/admin/requests'
import {
  approveRevisionSchema,
  decisionIdSchema,
  rejectRevisionSchema,
  requestChangesSchema
} from '@/lib/admin/schemas'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/** Review decisions on an owner's revision of a live listing: approve, request changes, reject. */
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ action: string; id: string }>
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  const { action, id } = await params
  const revisionId = decisionIdSchema.safeParse(id)
  if (!revisionId.success) return unknownAdminEndpoint()
  const actor = authorization.user.email
  switch (action) {
    case 'approve':
      return runAdminDecision(request, actor, approveRevisionSchema, (context, body) =>
        approveRevision(context, { ...body, revisionId: revisionId.data })
      )
    case 'request-changes':
      return runAdminDecision(request, actor, requestChangesSchema, (context, body) =>
        requestRevisionChanges(context, { ...body, revisionId: revisionId.data })
      )
    case 'reject':
      return runAdminDecision(request, actor, rejectRevisionSchema, (context, body) =>
        rejectRevision(context, { ...body, revisionId: revisionId.data })
      )
    default:
      return unknownAdminEndpoint()
  }
}
