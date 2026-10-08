import { requireAccountUser } from '@/lib/account/pages'
import { checkoutResponse, isRouterRequest, noStore, withCheckout } from '@/lib/billing/http'
import { startListingCheckout } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /account/listings/<slug>/checkout/` (#68): "Upgrade: $49 one-off" for the owner's live
 * free listing, or "Relist for $49" for one the badge program unlisted. Opens (or reuses) the
 * provider's checkout; a listing that can't be paid for goes back to its account page.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  if (isRouterRequest(request)) return noStore(204)
  const { slug } = await context.params
  const path = `/account/listings/${encodeURIComponent(slug)}/checkout/`
  const user = await requireAccountUser(path)
  return withCheckout(
    request,
    path,
    async ({ deps, origin }) =>
      checkoutResponse(
        await startListingCheckout(deps, { email: user.email, origin, slug, userId: user.id })
      ),
    user
  )
}
