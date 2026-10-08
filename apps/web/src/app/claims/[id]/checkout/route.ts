import { checkoutResponse, isUuid, noStore, withCheckout } from '@/lib/billing/http'
import { startClaimCheckout } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /claims/<id>/checkout/` (#67, #68; screen 8's "Continue to payment"): opens (or reuses)
 * the payment provider's checkout for the user's confirmed paid claim and sends them there. 404
 * unless orders and claims are both on; a claim that can't be paid for (any more) goes back to
 * the listing's claim dialog, which shows where it stands.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!isUuid(id)) return noStore(404, 'Not found')
  return withCheckout(request, `/claims/${id}/checkout/`, async ({ deps, origin, user }) =>
    checkoutResponse(
      await startClaimCheckout(deps, { claimId: id, email: user.email, origin, userId: user.id })
    )
  )
}
