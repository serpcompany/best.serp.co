import { requireAccountUser } from '@/lib/account/pages'
import { isRouterRequest, isUuid, noStore, redirectTo, withCheckout } from '@/lib/billing/http'
import { confirmReturn } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /account/listings/<slug>/checkout/success/?order=<order id>` (#68): the provider's
 * return after an upgrade or relist payment. Confirms and applies it, then opens the listing in
 * the account.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  if (isRouterRequest(request)) return noStore(204)
  const { slug } = await context.params
  const orderId = new URL(request.url).searchParams.get('order')
  const account = `/account/listings/${encodeURIComponent(slug)}/`
  const user = await requireAccountUser(account)
  return withCheckout(
    request,
    account,
    async ({ deps }) => {
      if (isUuid(orderId)) await confirmReturn(deps, { orderId, userId: user.id })
      return redirectTo(account)
    },
    user
  )
}
