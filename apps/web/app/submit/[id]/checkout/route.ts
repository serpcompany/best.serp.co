import { checkoutResponse, isUuid, noStore, withCheckout } from '@/lib/billing/http'
import { startSubmissionCheckout } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/**
 * `GET /submit/<id>/checkout/` (#68, #70 screen 4): the owner's paid listing checkout. The
 * choose and badge steps' "$49" links and the draft reminder's "Complete checkout" open it. It
 * opens (or reuses) the provider's checkout and sends the buyer there; a submission that can no
 * longer be paid for goes to its account page.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!isUuid(id)) return noStore(404, 'Not found')
  return withCheckout(request, `/submit/${id}/checkout/`, async ({ deps, origin, user }) =>
    checkoutResponse(
      request,
      await startSubmissionCheckout(deps, {
        email: user.email,
        origin,
        submissionId: id,
        userId: user.id
      })
    )
  )
}
