import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { type OrderRow, OrdersManager } from '@/components/admin/orders-manager'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { type AdminOrderRow, PROVIDER_ACTOR } from '@/db/billing'
import { DISPUTE_DECIDES_REFUND_NOTE } from '@/db/submission-plans'
import { formatUsd } from '@/lib/admin/format'
import { getAdminOrders } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'
import { billing, ordersEnabled } from '@/lib/billing/runtime'
import { disputeBlocksRefund, orderDiscountCents } from '@/lib/billing/service'
import { mediaBaseUrl } from '@/lib/media/media-base'
import { renderableImage } from '@/lib/media/renderable-image'
import { site } from '@/lib/site'

/** Orders (#68, #70 screen 13). A 404 while orders are off. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Orders' }

/** The line under an order's status (#70 screen 13's notes). */
function note(order: AdminOrderRow): string | null {
  // The provider kept refusing this refund; the sweep stopped, and "Refund…" retries it.
  if (order.attention === 'refund_failed') return 'Refund failed'
  // A dispute, and a refund made outside the site, both reported by the webhook (#473). A
  // rejection made no refund while the payment was disputed (#483).
  const rejected =
    order.status === 'paid' && order.refundNote === DISPUTE_DECIDES_REFUND_NOTE
      ? ' · rejected: the dispute decides the refund'
      : ''
  if (order.disputeStatus === 'open') return `Disputed${rejected}`
  if (order.disputeStatus === 'won')
    return `Dispute won${rejected ? ' · rejected, not refunded' : ''}`
  if (order.disputeStatus === 'lost') return `Dispute lost${rejected}`
  if (order.status === 'refunded') {
    if (order.refundedBy === PROVIDER_ACTOR) return 'Refunded outside the site'
    if (order.refundReason === 'rejected') return 'Auto refund on reject'
    if (order.refundListingAction === 'unpublish') return 'Listing unpublished (no badge)'
    return null
  }
  if (order.status === 'failed') {
    return order.failureReason === 'payment_failed' ? 'Card declined' : null
  }
  if (order.status === 'paid') {
    // Part of it refunded outside the site (#484): the amount sent back so far.
    if (order.partialRefundCents !== null) {
      return `Partly refunded outside the site: ${formatUsd(order.partialRefundCents)}`
    }
    if (order.rejectionCategory === 'prohibited') return 'Rejected: prohibited'
    if (
      order.listingLive &&
      order.submissionStatus === 'approved' &&
      order.latestBadgeOutcome === 'pass'
    ) {
      return 'Badge passing'
    }
  }
  return null
}

async function billingOrNull() {
  try {
    return await billing()
  } catch {
    return null
  }
}

export default async function OrdersPage() {
  const user = await requireAdmin()
  if (!(await ordersEnabled())) notFound()
  const deps = await billingOrNull()
  const media = await mediaBaseUrl()
  const orders: OrderRow[] = (await getAdminOrders()).map(order => {
    const charged = order.chargedCents ?? order.amountCents
    // A promotion code's discount (#250), never a mismatched charge's shortfall.
    const discountCents = orderDiscountCents(order)
    // The code is on the checkout, so a discounted order links there; others to the payment.
    const paymentRef =
      (discountCents > 0 ? order.providerCheckoutId : order.providerPaymentId) ??
      order.providerPaymentId ??
      order.providerCheckoutId
    return {
      // What was charged (and what a refund sends back): less after a promotion code (#250).
      amountCents: charged,
      createdAt: order.createdAt,
      customer: order.buyerEmail,
      id: order.id,
      item: order.productName
        ? {
            logoUrl: renderableImage({ key: order.logoKey }, media),
            name: order.productName,
            website: order.website ?? ''
          }
        : null,
      discountCents,
      kind: order.kind === 'paid_claim' ? 'Paid claim' : 'Paid listing',
      listingHref: order.listingSlug
        ? `/admin/listings/${encodeURIComponent(order.listingSlug)}/`
        : null,
      note: note(order),
      number: order.number,
      // A refund a failure left can be finished from here too (the sweep also retries it); a
      // disputed payment can't be refunded (#473).
      refundable:
        (order.status === 'paid' || order.status === 'refunding') && !disputeBlocksRefund(order),
      status: order.status,
      paymentRef,
      paymentUrl: paymentRef && deps ? deps.provider.dashboardUrl(paymentRef) : null
    }
  })
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Orders' }]} />
      <DashboardPageHeader
        title="Orders"
        description={`Paid listings and paid claims. ${formatUsd(site.submissions.paidListingPriceCents)} USD, one-off.`}
      />
      <OrdersManager actor={user.email} orders={orders} />
    </>
  )
}
