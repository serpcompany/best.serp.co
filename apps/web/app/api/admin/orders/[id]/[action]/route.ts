import { z } from 'zod'
import { previewOrderRefund, refundOrder } from '@/lib/admin/decisions'
import { runAdminDecision, unknownAdminEndpoint } from '@/lib/admin/requests'
import { decisionIdSchema } from '@/lib/admin/schemas'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * Order actions (#68, #70 screen 13): `refund-preview` (the dialog's decision, with the badge
 * checked at refund) and `refund` (with that check and the reason for the activity log). 404
 * while orders are off.
 */
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ action: string; id: string }>
}

const emptyBody = z.object({}).passthrough()
const refundBody = z.object({
  badgeCheckId: z.number().int().positive().nullable().optional(),
  note: z.string().max(500).optional()
})

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  const { action, id } = await params
  const orderId = decisionIdSchema.safeParse(id)
  if (!orderId.success) return unknownAdminEndpoint()
  const actor = authorization.user.email
  if (action === 'refund-preview') {
    return runAdminDecision(request, actor, emptyBody, context =>
      previewOrderRefund(context, { orderId: orderId.data })
    )
  }
  if (action !== 'refund') return unknownAdminEndpoint()
  return runAdminDecision(request, actor, refundBody, (context, body) =>
    refundOrder(context, { ...body, orderId: orderId.data })
  )
}
