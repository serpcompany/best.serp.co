import type { AdminOrderRow } from '@serpdirectory/data-ops/billing'
import { site } from '@serpdirectory/site-config'
import { DashboardPageHeader } from '@serpdirectory/web-core/dashboard/page-header'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { formatUsd } from '@/components/admin/format'
import { type OrderRow, OrdersManager } from '@/components/admin/orders-manager'
import { getAdminOrders } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'
import { billing, ordersEnabled } from '@/lib/billing/runtime'
import { mediaBaseUrl } from '@/lib/media/media-base'
import { renderableImage } from '@/lib/media/renderable-image'

/** Orders (#68, #70 screen 13). A 404 while orders are off. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Orders' }

/** The line under an order's status (#70 screen 13's notes). */
function note(order: AdminOrderRow): string | null {
  // The provider kept refusing this refund; the sweep stopped, and "Refund…" retries it.
  if (order.attention === 'refund_failed') return 'Refund failed'
  if (order.status === 'refunded') {
    if (order.refundReason === 'rejected') return 'Auto refund on reject'
    if (order.refundListingAction === 'unpublish') return 'Listing unpublished (no badge)'
    return null
  }
  if (order.status === 'failed') {
    return order.failureReason === 'payment_failed' ? 'Card declined' : null
  }
  if (order.status === 'paid') {
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
    const paymentRef = order.providerPaymentId ?? order.providerCheckoutId
    return {
      amountCents: order.amountCents,
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
      kind: order.kind === 'paid_claim' ? 'Paid claim' : 'Paid listing',
      listingHref: order.listingSlug
        ? `/admin/listings/${encodeURIComponent(order.listingSlug)}/`
        : null,
      note: note(order),
      number: order.number,
      // A refund a failure left can be finished from here too (the sweep also retries it).
      refundable: order.status === 'paid' || order.status === 'refunding',
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
