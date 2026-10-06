import { DashboardPageHeader } from '@serpdirectory/web-core/dashboard/page-header'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { type OrderRow, OrdersManager } from '@/components/admin/orders-manager'
import { getAdminOrders } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'
import { ordersEnabled } from '@/lib/billing/runtime'

/** Orders (#68, #70 screen 13). A 404 while orders are off. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Orders' }

export default async function OrdersPage() {
  await requireAdmin()
  if (!(await ordersEnabled())) notFound()
  const orders: OrderRow[] = (await getAdminOrders()).map(order => {
    const listingOrder =
      order.purpose !== 'claim' && order.appliedAt !== null && order.outcome !== 'unapplied'
    return {
      amountCents: order.amountCents,
      buyerEmail: order.buyerEmail,
      checksBadge: listingOrder && order.listingLive && order.submissionStatus === 'approved',
      createdAt: order.createdAt,
      id: order.id,
      inReview:
        listingOrder &&
        (order.submissionStatus === 'paid_pending_review' ||
          order.submissionStatus === 'verified' ||
          order.submissionStatus === 'changes_requested'),
      listingLive: order.listingLive,
      listingSlug: order.listingSlug,
      productName: order.productName,
      purpose: order.purpose,
      refundable: order.status === 'paid',
      status: order.status
    }
  })
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Orders' }]} />
      <DashboardPageHeader title="Orders" description="Paid listings and claims, newest first." />
      <OrdersManager orders={orders} />
    </>
  )
}
