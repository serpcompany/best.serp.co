import { checkoutResponse, isUuid, noStore, withCheckout } from '@/lib/billing/http'
import { startSubmissionCheckout } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /submit/<id>/checkout/start/` (#68): opens (or reuses) the provider's checkout for the
 * owner's submission and sends the buyer there. The handoff page (`/submit/<id>/checkout/`,
 * #70 screen 4a) and the cancelled and failed states' buttons open it. A submission that can no
 * longer be paid for goes to its account page.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!isUuid(id)) return noStore(404, 'Not found')
  return withCheckout(request, `/submit/${id}/checkout/`, async ({ deps, origin, user }) =>
    checkoutResponse(
      await startSubmissionCheckout(deps, {
        email: user.email,
        origin,
        submissionId: id,
        userId: user.id
      })
    )
  )
}
