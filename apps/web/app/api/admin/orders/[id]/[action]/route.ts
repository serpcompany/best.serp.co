import { z } from 'zod'
import { refundOrder } from '@/lib/admin/decisions'
import { runAdminDecision, unknownAdminEndpoint } from '@/lib/admin/requests'
import { decisionIdSchema } from '@/lib/admin/schemas'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/** Order actions (#68, #70 screen 13): `refund`. 404 while orders are off. */
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ action: string; id: string }>
}

const emptyBody = z.object({}).passthrough()

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  const { action, id } = await params
  const orderId = decisionIdSchema.safeParse(id)
  if (!orderId.success || action !== 'refund') return unknownAdminEndpoint()
  return runAdminDecision(request, authorization.user.email, emptyBody, context =>
    refundOrder(context, { orderId: orderId.data })
  )
}
