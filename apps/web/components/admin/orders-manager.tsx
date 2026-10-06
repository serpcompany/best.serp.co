'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@serpdirectory/design-system/alert-dialog'
import { Badge } from '@serpdirectory/design-system/badge'
import { Button } from '@serpdirectory/design-system/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@serpdirectory/design-system/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from '@serpdirectory/design-system/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@serpdirectory/design-system/table'
import { Tabs, TabsList, TabsTrigger } from '@serpdirectory/design-system/tabs'
import { EllipsisVertical } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { adminRequest } from './api'
import { formatDay, formatUsd } from './format'

/**
 * Orders (#68, #70 screen 13): Tabs by status, a table, and a row DropdownMenu with Refund,
 * confirmed in an AlertDialog that says what happens to the listing: a live paid listing has
 * its badge checked once at refund (a pass keeps it live as free, otherwise it is unpublished).
 */

export interface OrderRow {
  amountCents: number
  /** Flagged for an admin: a charge that didn't match, or a refund's listing change. */
  attention: 'amount_mismatch' | 'listing_update_failed' | null
  buyerEmail: string | null
  createdAt: string
  id: string
  listingLive: boolean
  listingSlug: string | null
  productName: string | null
  purpose: 'claim' | 'relist' | 'submission' | 'upgrade'
  refundable: boolean
  status: 'failed' | 'paid' | 'pending' | 'refunded' | 'refunding'
  /** The listing's paid plan is live and approved: the refund checks the badge first. */
  checksBadge: boolean
  /** Its submission is still in review: rejecting it refunds it instead. */
  inReview: boolean
}

type StatusTab = 'all' | OrderRow['status']

const STATUS_LABEL: Record<OrderRow['status'], string> = {
  failed: 'Failed',
  paid: 'Paid',
  pending: 'Pending',
  refunded: 'Refunded',
  refunding: 'Refunding'
}

const ATTENTION_LABEL: Record<NonNullable<OrderRow['attention']>, string> = {
  amount_mismatch: 'Amount mismatch',
  listing_update_failed: 'Listing not updated'
}

const PURPOSE_LABEL: Record<OrderRow['purpose'], string> = {
  claim: 'Claim',
  relist: 'Relist',
  submission: 'Submission',
  upgrade: 'Upgrade'
}

type RefundAnswer = { listing: 'kept_free' | 'pending' | 'unchanged' | 'unpublished' }

export function OrdersManager({ orders }: { orders: OrderRow[] }) {
  const router = useRouter()
  const [tab, setTab] = useState<StatusTab>('all')
  const [refunding, setRefunding] = useState<OrderRow | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(
    () => (tab === 'all' ? orders : orders.filter(order => order.status === tab)),
    [orders, tab]
  )

  const refund = async (order: OrderRow) => {
    setBusy(true)
    const result = await adminRequest<RefundAnswer>(`/api/admin/orders/${order.id}/refund`, {})
    setBusy(false)
    setRefunding(null)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    const name = order.productName ?? 'The listing'
    toast.success(
      result.listing === 'unpublished'
        ? `Refunded ${formatUsd(order.amountCents)}. ${name} was unpublished.`
        : result.listing === 'kept_free'
          ? `Refunded ${formatUsd(order.amountCents)}. ${name} stays live as a free listing.`
          : result.listing === 'pending'
            ? `Refunded ${formatUsd(order.amountCents)}. The listing update is pending.`
            : `Refunded ${formatUsd(order.amountCents)}.`
    )
    router.refresh()
  }

  return (
    <>
      <Tabs value={tab} onValueChange={value => setTab(value as StatusTab)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          {(['pending', 'paid', 'refunded', 'failed'] as const).map(status => (
            <TabsTrigger key={status} value={status}>
              {STATUS_LABEL[status]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No orders</EmptyTitle>
            <EmptyDescription>Orders appear here when someone opens a checkout.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="text-foreground first:pl-4">Product</TableHead>
                <TableHead className="text-foreground">Buyer</TableHead>
                <TableHead className="text-foreground">Type</TableHead>
                <TableHead className="text-foreground">Amount</TableHead>
                <TableHead className="text-foreground">Status</TableHead>
                <TableHead className="text-foreground">Date</TableHead>
                <TableHead className="text-right text-foreground last:pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(order => (
                <TableRow key={order.id} data-order={order.id}>
                  <TableCell className="font-medium first:pl-4">
                    {order.productName ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{order.buyerEmail ?? '—'}</TableCell>
                  <TableCell>{PURPOSE_LABEL[order.purpose]}</TableCell>
                  <TableCell className="tabular-nums">{formatUsd(order.amountCents)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">{STATUS_LABEL[order.status]}</Badge>
                      {order.attention ? (
                        <Badge variant="destructive">{ATTENTION_LABEL[order.attention]}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDay(order.createdAt)}
                  </TableCell>
                  <TableCell className="last:pr-4">
                    <div className="flex justify-end">
                      {order.refundable ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground"
                            >
                              <EllipsisVertical />
                              <span className="sr-only">Open menu for this order</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="text-destructive"
                              onSelect={() => setRefunding(order)}
                            >
                              Refund
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AlertDialog
        open={refunding !== null}
        onOpenChange={open => {
          if (!open && !busy) setRefunding(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Refund {refunding ? formatUsd(refunding.amountCents) : ''}
              {refunding?.buyerEmail ? ` to ${refunding.buyerEmail}` : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {refunding?.inReview
                ? 'This submission is still in review. Reject it from the review page instead.'
                : refunding?.checksBadge
                  ? 'We check the badge on the site first. If it passes, the listing stays live as a free listing. Otherwise it’s unpublished.'
                  : 'The listing isn’t changed.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || refunding?.inReview === true}
              onClick={event => {
                event.preventDefault()
                if (refunding) void refund(refunding)
              }}
            >
              Refund
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
