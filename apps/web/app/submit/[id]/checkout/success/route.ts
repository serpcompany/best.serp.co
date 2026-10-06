import { isUuid, noStore, redirectTo, withCheckout } from '@/lib/billing/http'
import { confirmReturn } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /submit/<id>/checkout/success/?order=<order id>` (#68): the provider's return after
 * payment. It confirms the payment with the provider and applies it if the webhook hasn't yet,
 * then opens the submission in the account, which shows where it stands (live and in review,
 * or in review).
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const orderId = new URL(request.url).searchParams.get('order')
  if (!isUuid(id)) return noStore(404, 'Not found')
  const account = `/account/submissions/${id}/`
  return withCheckout(request, account, async ({ deps, user }) => {
    if (isUuid(orderId)) await confirmReturn(deps, { orderId, userId: user.id })
    return redirectTo(account)
  })
}
