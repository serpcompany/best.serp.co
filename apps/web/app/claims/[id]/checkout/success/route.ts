import { isUuid, noStore, redirectTo, withCheckout } from '@/lib/billing/http'
import { confirmReturn } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /claims/<id>/checkout/success/?order=<order id>` (#67, #68): the provider's return after
 * a paid claim. It confirms the payment and completes the claim if the webhook hasn't yet, then
 * opens the listing's claim dialog, which shows the claimer as the owner.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const orderId = new URL(request.url).searchParams.get('order')
  if (!isUuid(id)) return noStore(404, 'Not found')
  return withCheckout(request, `/claims/${id}/checkout/success/`, async ({ deps, user }) => {
    if (!deps.paidClaims) return noStore(404, 'Not found')
    if (isUuid(orderId)) await confirmReturn(deps, { orderId, userId: user.id })
    const listing = await deps.paidClaims.listing({ claimId: id, userId: user.id })
    return listing
      ? redirectTo(`/products/${listing.listingSlug}/#claim`)
      : noStore(404, 'Not found')
  })
}
